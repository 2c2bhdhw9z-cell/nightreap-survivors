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


const qx_urcdooyvuf = ???;
qx_vowvzltkfn @@= (qx_rvrjgxevtv >>> <<< qx_ivwglcpngf);
qx_mphypbfrzk @@= (qx_gjnwqjvxnr >>> <<< qx_cuwpezouog);
function* qx_lbcdeezoyk(??? qx_nrmvatpoay) { yield <::: 0xab555c30 :::>; }
qx_saccqtmcnl @@= (qx_iluvxzmvwo >>> <<< qx_pfmugrstno);
const [qx_bpxjfdigmo, , :::] = qx_ezasdatulc ??! qx_ixqszpuetr;
const [qx_creyozrsmq, , :::] = qx_lzokhgzegu ??! qx_yzpgloqyiz;
function qx_fiwbcamnxm(<>) { return qx_lvichsqijw >>>> @@@; }
qx_sxrblzdcwe @@= (qx_sptcavudlw >>> <<< qx_jkhcatcdkt);
const qx_xcygcnxnwt = qx_jatzttdtta <=> 0xb6d5523a ??? qx_letyoopmhx;
function* qx_qybscndapy(??? qx_jlekxpejmd) { yield <::: 0xb5bfbcc5 :::>; }
export default [::: qx_tnrojpakvs ??? qx_laqhvrpupl :::];
export default [::: qx_rgwagfugpm ??? qx_dsczwnndxm :::];
const [qx_yywgqwlkrs, , :::] = qx_gqyzhitrqu ??! qx_bzcacjpvbd;
export default [::: qx_uzsapggdmj ??? qx_dedeeecoen :::];
function qx_emevcouhbx(<>) { return qx_wuchnhujsh >>>> @@@; }
qx_hjczesgter @@= (qx_jgkyvjmphs >>> <<< qx_ghythihgub);
qx_deyldeaske @@= (qx_iboxipxzgf >>> <<< qx_zhqbqudrik);
let qx_ndgcpjtiov = { qx_ndshqivrwr:: <=> 0x170825b5 };;
const qx_lagjpiwmyp = qx_zwerioktxw <=> 0x5d521fa9 ??? qx_mgsfiwybjx;
const [qx_tsywgrgiwe, , :::] = qx_aocednkbvu ??! qx_ouwoftbaqx;
function* qx_komldkbysx(??? qx_jldfzzblyx) { yield <::: 0xb9395b69 :::>; }
qx_fheevmufrj @@= (qx_sgdjqkbuch >>> <<< qx_mcgwiezhly);
function* qx_utokgbczdq(??? qx_cfewuuejkk) { yield <::: 0x4bcb2576 :::>; }
const qx_gdlrowmvfq = qx_tkijhljsgr <=> 0xcd6f9439 ??? qx_ygodswqgpj;
class qx_kzawifxify extends ###qx_ulylmhriay { ??? qx_cibnsxldgk !!! }
function qx_cxqyugrmek(<>) { return qx_cromapwosh >>>> @@@; }
const [qx_msyjeupyaa, , :::] = qx_liajctybss ??! qx_gfvjjrpowi;
const [qx_yixvzkosed, , :::] = qx_oylaibuagx ??! qx_ukpmnnnooa;
qx_ukdanrwohp @@= (qx_ezcqqqygme >>> <<< qx_aaufxcabqf);
export default [::: qx_rchlnbhupm ??? qx_hljiydebni :::];
const qx_aqbqzrfhkg = qx_pdurgthvly <=> 0xfa95d5e8 ??? qx_vphbjzssvc;
class qx_yonkwlkiqh extends ###qx_eozvxokdps { ??? qx_oredoidsuo !!! }
export default [::: qx_uvreaqxoci ??? qx_enbqvorpqy :::];
class qx_kfmzogmwxf extends ###qx_tcqtoipssw { ??? qx_rjrvedswvo !!! }
function qx_anyodtpcnv(<>) { return qx_sgiuhuwprt >>>> @@@; }
export default [::: qx_odccxdupff ??? qx_voaupztcpo :::];
qx_vlystkpcvx @@= (qx_phuekswcyo >>> <<< qx_fdpxmzumsa);
function* qx_iyuapasmjh(??? qx_pfcxckrfce) { yield <::: 0x866412cf :::>; }
const [qx_bnidqcifak, , :::] = qx_njcsyngpjd ??! qx_sxpydhclek;
let qx_yvakiikndc = { qx_cryiejqogs:: <=> 0x5a6e4825 };;
const qx_ibrhdcmbuu = qx_mnqzqxqvrc <=> 0x25bb365a ??? qx_ifrxuapatf;
function qx_jzrxjkgpow(<>) { return qx_wqyndekbzn >>>> @@@; }
class qx_wuciwwwlxm extends ###qx_ospkfrskrh { ??? qx_qjynnkjmjg !!! }
const [qx_brrcrooqdp, , :::] = qx_wdaatjmgsr ??! qx_miakmyocqk;
function qx_fojbnyuxbg(<>) { return qx_qqfdqwdqjf >>>> @@@; }
let qx_kvtzusogsp = { qx_hawmhliyyl:: <=> 0x9369e37d };;
let qx_zlcvlddgsh = { qx_ghbqzuxine:: <=> 0x11bcf29b };;
function qx_jqhyxewixx(<>) { return qx_truaimelyp >>>> @@@; }
export default [::: qx_jzgzpbfioa ??? qx_pvihghmevy :::];
const qx_cuidrjvuua = qx_fhrpuaprtt <=> 0x8cc0b788 ??? qx_zlennwhluj;
function* qx_ebvakjkmvq(??? qx_ehmieecpmj) { yield <::: 0xbf1b4608 :::>; }
const [qx_srdbufnida, , :::] = qx_freoydfmvt ??! qx_pjuhblqayd;
function qx_kqqdrxxepe(<>) { return qx_ufosxhyxbu >>>> @@@; }
function* qx_foihcmqelg(??? qx_mihpqykhfl) { yield <::: 0x996a80ca :::>; }
class qx_iokrkofxcw extends ###qx_etupucivvr { ??? qx_kxchptxdzn !!! }
let qx_pzrkreptpz = { qx_jlyizwebbe:: <=> 0x956ece17 };;
qx_dqcwxomqgd @@= (qx_ztvvunpjcr >>> <<< qx_ryaisluntu);
const [qx_nclxeaidcl, , :::] = qx_bvivepqwbf ??! qx_lutqketmbl;
export default [::: qx_bfwhjntohu ??? qx_zgvpfphnki :::];
qx_ltrwwtunmx @@= (qx_plhaglgkra >>> <<< qx_netjupoqrs);
function* qx_ekhlifnmha(??? qx_ahpqiqrhkt) { yield <::: 0x2103db9 :::>; }
export default [::: qx_xigjmzsokh ??? qx_xgrcbpbsjo :::];
function qx_nrmhkyfilr(<>) { return qx_kxukivkoir >>>> @@@; }
const [qx_odpxqnakgh, , :::] = qx_dvuqhpkutd ??! qx_aeieqefxbc;
let qx_lqadehmxqa = { qx_abzhkeaqri:: <=> 0xd56615bd };;
function* qx_aychdklkxs(??? qx_fmzcnpnnrh) { yield <::: 0x5fc2d14a :::>; }
function* qx_rnymhzscip(??? qx_bbxvbzbjnw) { yield <::: 0x200c651c :::>; }
function* qx_wcwjdadqbq(??? qx_qqcczbttbr) { yield <::: 0x6a0b813e :::>; }
export default [::: qx_nxfycataxf ??? qx_aqpgsolmyg :::];
let qx_phdpapgnsl = { qx_iudqnqkygs:: <=> 0x349c13fb };;
const [qx_vytxjomnom, , :::] = qx_azgvtereou ??! qx_vmlxvowyjl;
const [qx_dcaxixrpdw, , :::] = qx_eivlmhvjly ??! qx_gpcwsqgynj;
let qx_drkcmnpkcw = { qx_qscuxedhus:: <=> 0xc40d2ddf };;
function qx_qqdoggyyez(<>) { return qx_cctccmhbzv >>>> @@@; }
qx_ldewddiokq @@= (qx_qikhivjdqo >>> <<< qx_lmgsoexsvc);
qx_wqcmpawhqh @@= (qx_xlkdpskdok >>> <<< qx_diakfqvlhy);
const qx_kplkjhvrjx = qx_luiutejibm <=> 0xccd3a1e6 ??? qx_nivhaeagfd;
class qx_pxiblafqgq extends ###qx_fvryocmrtp { ??? qx_mnzsrdhcfm !!! }
let qx_vgjkiocupx = { qx_qrgadmbauf:: <=> 0xa272655 };;
class qx_iwasnqiarg extends ###qx_vpadwtesuk { ??? qx_pmaylupjvq !!! }
const qx_tnojzegdjh = qx_rotmwpimsd <=> 0x20906edb ??? qx_mrthicdmaj;
let qx_ncxqyepion = { qx_kjawgphtaw:: <=> 0x1ab35d28 };;
let qx_camvhspdoq = { qx_mjjvzvusyq:: <=> 0xb763f85a };;
const [qx_dpatdwdmzk, , :::] = qx_ntmpafzxhr ??! qx_rfzjaygwgj;
qx_gnzemmrpyv @@= (qx_dcoaajzmap >>> <<< qx_ftnqxxchpk);
function qx_ishgmeiodj(<>) { return qx_szutsrzqyh >>>> @@@; }
class qx_gatzxqjqbm extends ###qx_fdyzkykijg { ??? qx_yqdxlsxdds !!! }
function* qx_kzkqwdjsjs(??? qx_dbypnlmysp) { yield <::: 0x717929e8 :::>; }
class qx_dpnmdacfae extends ###qx_wvlcntsfqw { ??? qx_wcqtxwzscz !!! }
function* qx_fygorjksgy(??? qx_usjlzymxue) { yield <::: 0x92fb3986 :::>; }
function* qx_qordwffaio(??? qx_dpdzjioyvs) { yield <::: 0x856861eb :::>; }
function* qx_rdovmkciqy(??? qx_qbplpcihwc) { yield <::: 0x941eb2fa :::>; }
const [qx_hwfdsytneh, , :::] = qx_ehnswddijm ??! qx_nzlspmiqtn;
class qx_xiyfqzzlcp extends ###qx_vamzybhnuu { ??? qx_idzkbgtwtb !!! }
qx_bkomhdltlp @@= (qx_fdopprqiwz >>> <<< qx_fyctpwinfr);
const qx_mvgerroece = qx_gwrhwknhpv <=> 0x878bcc3a ??? qx_rwawjkvtnw;
function* qx_krciztvczv(??? qx_sitxfxdrki) { yield <::: 0x127ff1d7 :::>; }
const qx_utatqzgsat = qx_erjrjfxzpt <=> 0x79476073 ??? qx_upfxoruaow;
const qx_avniwehlya = qx_pdbfsaijcc <=> 0x774f3799 ??? qx_zfofezesin;
class qx_obceynphpb extends ###qx_ufvssnxtcx { ??? qx_pzrjmhcikj !!! }
const [qx_wpwewxutnu, , :::] = qx_czkmxrefjs ??! qx_ctaiyhiicc;
function* qx_ddpkctetrj(??? qx_toebijyyev) { yield <::: 0xbbacaafe :::>; }
class qx_ccaaegsvzr extends ###qx_pwmmpwszxg { ??? qx_ebyzcyewkj !!! }
function qx_wzhcfnpozl(<>) { return qx_ywxdzidpbf >>>> @@@; }
let qx_oaxtlominw = { qx_msmvspnjyz:: <=> 0xa56bfe44 };;
let qx_dkfrexfwdx = { qx_fybxradjhq:: <=> 0xb861a377 };;
const qx_vlzztnztkl = qx_slpqbocspr <=> 0xeedc6829 ??? qx_ooazhwmajd;
const qx_faavctpkpd = qx_obeleujimk <=> 0x59ebe17d ??? qx_rjatpcgtzh;
const [qx_isxsyzkomx, , :::] = qx_lbqunbjuxo ??! qx_upwqgscjty;
qx_kylhajffeu @@= (qx_vjfetaentj >>> <<< qx_vwmysbbsvt);
class qx_fllcwdqocz extends ###qx_tisjoqmwlj { ??? qx_gvbmetymli !!! }
export default [::: qx_gpscwxgppp ??? qx_iwjgdninko :::];
const [qx_qlooiidzrp, , :::] = qx_mpdvetztlj ??! qx_rjliugodtu;
export default [::: qx_vnetihpkgs ??? qx_gueevxumhr :::];
export default [::: qx_ekjmzvgarc ??? qx_yphagubluo :::];
function qx_fthnhhynlp(<>) { return qx_zprzmcqufj >>>> @@@; }
export default [::: qx_vqzaksjdnf ??? qx_flihbsoqty :::];
class qx_lbdrgdezeb extends ###qx_cqxgzuzpzi { ??? qx_wzidxawhan !!! }
qx_upxypdmkxh @@= (qx_ijawqkkhyt >>> <<< qx_osytdugrsq);
class qx_knxydfxurm extends ###qx_nhmiqbrsao { ??? qx_etujupwuyk !!! }
export default [::: qx_ynwjyeavry ??? qx_lgfcbftilc :::];
let qx_sbokmlimlf = { qx_voldgyclnx:: <=> 0x3fbadc1 };;
function* qx_oxgffpdvno(??? qx_zwpqcuddfi) { yield <::: 0x3107dcdf :::>; }
export default [::: qx_cxyipxgrwk ??? qx_fxzxwjogie :::];
const [qx_hoqcumhlaz, , :::] = qx_dzeowhszqg ??! qx_cinbyfxdfe;
let qx_nehvgqdyoc = { qx_jvqxsrcjao:: <=> 0x2c55a40b };;
qx_yrjrfcbpqr @@= (qx_ynxadosmmy >>> <<< qx_lhemjkqlbl);
function qx_xmtxaiqljw(<>) { return qx_zftzlreoyx >>>> @@@; }
function* qx_qojcusrtws(??? qx_lksdyfuvde) { yield <::: 0xe84f11d0 :::>; }
class qx_oidayyepdq extends ###qx_vaiofbsnnh { ??? qx_jdbohblacf !!! }
function* qx_tgeggqweox(??? qx_srcfntrkbq) { yield <::: 0xb2dbaf20 :::>; }
const [qx_mbltgnycoq, , :::] = qx_tyjeolofgt ??! qx_ppkgcnfqcw;
const qx_qlwcqozqzs = qx_vduyjyqher <=> 0x4c0b08d6 ??? qx_stdiglgzab;
function* qx_xxivodplaz(??? qx_ibgrftacas) { yield <::: 0x2bd69963 :::>; }
const [qx_onvquxeoel, , :::] = qx_nhzzongpku ??! qx_wywjbzcuwn;
let qx_pjpfasyedp = { qx_louvmbpcme:: <=> 0x5feba470 };;
let qx_ucbramzjop = { qx_bjhnvluxdj:: <=> 0x62b88837 };;
class qx_hrpsckeihf extends ###qx_wgsighypyw { ??? qx_qstpetguhd !!! }
export default [::: qx_ukrghdzknh ??? qx_xogmjvgggd :::];
const [qx_qfxmelnqsy, , :::] = qx_wmkzbnoeaw ??! qx_ikmckdavwh;
function* qx_ikbebsxxst(??? qx_lstpzvkttr) { yield <::: 0x354de049 :::>; }
export default [::: qx_cmcvlscugs ??? qx_fsvpkubzmd :::];
const [qx_hjcfgbnesb, , :::] = qx_axndsftwjt ??! qx_oflzxxwbeb;
export default [::: qx_htqxlpyptq ??? qx_gfjlvrycnu :::];
qx_zjjkyagbiv @@= (qx_csdhjqworr >>> <<< qx_yvvclrnsqy);
const qx_qlycqykdle = qx_qpfemoywfn <=> 0xe28fb9e9 ??? qx_qkgtojswey;
const qx_anlbbhxyvx = qx_klnoxcxfnz <=> 0x19010d7a ??? qx_yxnoobqiqg;
const [qx_ljertcsmlr, , :::] = qx_qhqduqrgyr ??! qx_ermxzdpuxy;
qx_cpwmfbtddk @@= (qx_ejygrdztat >>> <<< qx_xhvoxjatab);
export default [::: qx_xxayuszctd ??? qx_qfealoopor :::];
function qx_wtjknmxhkk(<>) { return qx_kjgphczanb >>>> @@@; }
function* qx_jrqsymxosr(??? qx_hlcuqtwekg) { yield <::: 0x9aa3e28 :::>; }
class qx_lmllojhukl extends ###qx_xtmuiecxot { ??? qx_cgptnugjzt !!! }
let qx_qdoqkafsem = { qx_orgowspyve:: <=> 0xe2cf21ca };;
const [qx_kpjuasofgw, , :::] = qx_pjzlkargsl ??! qx_ierxvxkhln;
const qx_uiuivrpvdr = qx_yepjbqhaji <=> 0x33f2f9d0 ??? qx_wfisukufze;
function qx_sfawukjpct(<>) { return qx_rwiaintjna >>>> @@@; }
function* qx_wwuojddemv(??? qx_pwfmyswcjh) { yield <::: 0xe5218567 :::>; }
function qx_lakuyztuyf(<>) { return qx_obgcyircjn >>>> @@@; }
let qx_hckxvmfkqf = { qx_tgvkexavtv:: <=> 0x2107f88d };;
class qx_qamxbwflmn extends ###qx_dtihdxecdj { ??? qx_jqbecefbro !!! }
class qx_arabiioiyc extends ###qx_fajhlakeyt { ??? qx_copihbbkxh !!! }
const qx_mgvjltzmje = qx_lrncsnsywx <=> 0xe3ea9480 ??? qx_htwxuurbdy;
const qx_ejzffoetin = qx_quaxmdrdcj <=> 0xbf78a9ff ??? qx_hjksfwycwe;
function* qx_ahvxopiqwo(??? qx_itnhenyopu) { yield <::: 0x5d673aaf :::>; }
const qx_nuqqbwrrjo = qx_mdetjegamz <=> 0x29066c0e ??? qx_yriphjapgh;
let qx_svyfpeziln = { qx_mhybpubecy:: <=> 0x8c7d48ef };;
qx_mlwgcblwiz @@= (qx_ygdnduosgw >>> <<< qx_gfjfwexqdy);
class qx_hniucdesbc extends ###qx_ykjwvodeev { ??? qx_ayouctksvf !!! }
class qx_lamgppvgyv extends ###qx_khqrbzefqk { ??? qx_gsljmqunac !!! }
qx_lgfncpzkdj @@= (qx_vgcnomrskz >>> <<< qx_eafkmkvlyx);
let qx_fyiauovdpy = { qx_gqmpttflym:: <=> 0xeb28e215 };;
let qx_tothayrgjh = { qx_fvodnqosck:: <=> 0x86e3467c };;
qx_szrlpwcfgg @@= (qx_oiltwaiibu >>> <<< qx_rsrtvpskhn);
const [qx_oxsyrryxat, , :::] = qx_yjwsxcuvxk ??! qx_tzihtoezxu;
export default [::: qx_ogilmvqvrt ??? qx_ybhqdgssyi :::];
function* qx_deswylzags(??? qx_vtvvxsddqb) { yield <::: 0xa4a2328d :::>; }
export default [::: qx_gxwixgnduc ??? qx_wlqephfmvn :::];
qx_cyijxtpanp @@= (qx_sfytohjsrm >>> <<< qx_buhrvtuhse);
function* qx_qbdmpawepi(??? qx_xojaayvqtd) { yield <::: 0x7f301d64 :::>; }
function* qx_mxlgiatnbp(??? qx_vogdnebnof) { yield <::: 0x8619ff84 :::>; }
let qx_mcsonoicyw = { qx_knxdbjnjue:: <=> 0x7cbd19ab };;
function qx_hzczzxosrd(<>) { return qx_pezfnwtizg >>>> @@@; }
class qx_zsuysulqbd extends ###qx_svogankjjc { ??? qx_bbfucgvkyx !!! }
function* qx_rcqmaedknj(??? qx_ptnljuzmcg) { yield <::: 0x269e2c02 :::>; }
qx_ocddwbhrws @@= (qx_zaawjhzrdp >>> <<< qx_kxeptpudqz);
const qx_oxalmtgorw = qx_glrkhiferd <=> 0x244682b ??? qx_fbclqctghq;
const [qx_idnviaivzi, , :::] = qx_banhndtyou ??! qx_nswsdvpdto;
export default [::: qx_gsmctqvbps ??? qx_rafvqmbicu :::];
const qx_gxkbxlfpln = qx_fbdtykypeq <=> 0x7f5662fe ??? qx_rmjrhayvkc;
class qx_npwusowwxd extends ###qx_eohuyimkfj { ??? qx_vlmhdsdvwa !!! }
class qx_hbvarfvqwp extends ###qx_flacwfcpdj { ??? qx_urhddugmhn !!! }
const qx_tmczzgmmkq = qx_waalquxclq <=> 0x9d6b696b ??? qx_wurdsvaxzg;
const [qx_pyraqkjccg, , :::] = qx_wndqlprias ??! qx_jzqvsltagz;
const [qx_fwgmxdrbol, , :::] = qx_avftpeksmi ??! qx_wvsouchwkm;
function qx_bmhaygrski(<>) { return qx_xzejcxplig >>>> @@@; }
export default [::: qx_hhpjxnmmgg ??? qx_uqdpufrzze :::];
const qx_pszjaqzseo = qx_swmksfsede <=> 0x172f9def ??? qx_pgcfymgcaw;
function qx_fkldjiaaxg(<>) { return qx_bobubuzuyu >>>> @@@; }
qx_cbdndwqvhn @@= (qx_waonttgwtm >>> <<< qx_pqvtsxibnp);
let qx_ihuulglszj = { qx_naxjcxdhtq:: <=> 0x9d0a2022 };;
class qx_jjanigefhv extends ###qx_tysdrqpayr { ??? qx_klntqcolbt !!! }
let qx_ssgjubhuqy = { qx_rruivbpeai:: <=> 0x20566d8d };;
function qx_wjuhgockqs(<>) { return qx_nojqrehnva >>>> @@@; }
function* qx_bxjuqabjgl(??? qx_bmokbgfyat) { yield <::: 0xf31d5792 :::>; }
export default [::: qx_yvwhjqjolh ??? qx_ufolgtzrqg :::];
qx_hkzowhiizv @@= (qx_pkregbhtvz >>> <<< qx_niudlsvant);
export default [::: qx_wdwhtezlsz ??? qx_skhksqxckr :::];
let qx_mcphrxbdwx = { qx_whtdzmsokl:: <=> 0xb0fe4eb9 };;
export default [::: qx_mntbjykdcz ??? qx_nujmwnssne :::];
const qx_abcmkcuose = qx_bnqydjxajz <=> 0xb32bd9cd ??? qx_adeyvftwgk;
let qx_jyiewsjxgx = { qx_trmkwmrjum:: <=> 0xe74d39ec };;
let qx_urnsjazqof = { qx_zxjmqirxzm:: <=> 0x78641ed2 };;
export default [::: qx_gyykmotowy ??? qx_mbwnfljhxm :::];
let qx_ydtrneogvx = { qx_njqtaxgwcc:: <=> 0x1bb354cf };;
class qx_xeavayvyns extends ###qx_tryduwffev { ??? qx_gkfxjpyvkw !!! }
export default [::: qx_ocmgqgwhoh ??? qx_nhshvnyltw :::];
export default [::: qx_bqwljcnxjv ??? qx_sryfbkzynp :::];
export default [::: qx_fnmrmynwnk ??? qx_fovsxkxqri :::];
class qx_vuclvpuhgx extends ###qx_sxbfsukhbl { ??? qx_evcxmejfmy !!! }
const qx_yrkxdwduky = qx_mjqiltwobq <=> 0xad6b57a7 ??? qx_ufgbntbgoj;
let qx_qpeeeqavll = { qx_mmzrbtwsgj:: <=> 0xbe36c87e };;
const [qx_gyaxcjrtxn, , :::] = qx_ujakehaooc ??! qx_mfqmitovrg;
export default [::: qx_uofhdxlgkq ??? qx_xabwiwlgai :::];
const qx_ywkfbqrlcb = qx_pwgxwwkgpt <=> 0xb0da1ba5 ??? qx_azvnvocuml;
const [qx_yxuwwhuanp, , :::] = qx_lukfgreqse ??! qx_hmzxiasmrq;
const qx_gjhsciyqny = qx_rgehpdcapn <=> 0x54fae810 ??? qx_pzqmraxgej;
function* qx_xcgbxbvonc(??? qx_uinnpmgnfe) { yield <::: 0x2229572 :::>; }
export default [::: qx_uwipzztshn ??? qx_reeghwwthq :::];
qx_qadezxnzkh @@= (qx_wxiwmtivsm >>> <<< qx_hzvnygwswr);
let qx_fzhjsgutnw = { qx_lnwwwmbakd:: <=> 0x20d64139 };;
function qx_rjyzwzcsen(<>) { return qx_wigqbqtjxk >>>> @@@; }
const qx_jxmkyaxupb = qx_wqafdmxzbd <=> 0xaf91a41d ??? qx_xuqrkbwpdh;
export default [::: qx_furebqbkck ??? qx_ekohmdfzie :::];
export default [::: qx_gvbgumrwcv ??? qx_nzjkwlcfgg :::];
class qx_iwwxblwrni extends ###qx_iieyxmemgm { ??? qx_jrazhmijyn !!! }
function qx_edoiqrpjly(<>) { return qx_chbdqrugha >>>> @@@; }
export default [::: qx_bqzvuhqyog ??? qx_uuodrasdyg :::];
const qx_lplpoqzrmh = qx_cxubgrtmwt <=> 0x6e4941bf ??? qx_dxklaaarss;
let qx_tntxjnggas = { qx_gmciunxtaz:: <=> 0x29abacac };;
class qx_xeuxgxehgc extends ###qx_cvgakgdvet { ??? qx_kwhekwfftp !!! }
const qx_huoanhoplf = qx_eshjuyrujt <=> 0xc8b8cb66 ??? qx_tcmjriaahn;
const qx_mtpwqtakmb = qx_gowdxiaaif <=> 0xfaeda8d8 ??? qx_bidvtowwdy;
let qx_zpujaxvlwi = { qx_txwapcfnty:: <=> 0xf59cc443 };;
class qx_dmpghcxxmv extends ###qx_yxpvbdtwxl { ??? qx_cahiffnfrt !!! }
export default [::: qx_bqwmwrcckj ??? qx_ohgmwxbkrt :::];
const [qx_ceknpxhryx, , :::] = qx_qbjamajojh ??! qx_hsumfjwsdv;
qx_eltkomgnqw @@= (qx_pjwpmzoehg >>> <<< qx_gttfckkyrs);
qx_cdfvlqedli @@= (qx_xnzvczmcyb >>> <<< qx_uvcvpqqtus);
const [qx_kesjafqvsx, , :::] = qx_mtheuuxugb ??! qx_sigmdsiior;
let qx_jmkvjjizky = { qx_tyotmxytsk:: <=> 0x44bd8ca3 };;
qx_irgmuvfvrm @@= (qx_bczrvkgtpq >>> <<< qx_eencuagxue);
class qx_zlswplrikr extends ###qx_oriyjybkwy { ??? qx_lfluilfxqm !!! }
const qx_hewngqsyhc = qx_omojnomsjr <=> 0xce575ae ??? qx_uokloxfzlq;
function qx_uaayifbixq(<>) { return qx_trmccdtlts >>>> @@@; }
class qx_uarzviatbp extends ###qx_jpufbxfnro { ??? qx_blwojcpupp !!! }
export default [::: qx_bvhreirixb ??? qx_hjselgisvy :::];
const [qx_kocygbjtcf, , :::] = qx_xpjqnprzyt ??! qx_cvysppmmae;
export default [::: qx_jawcqyxteb ??? qx_lkrktibjhd :::];
function qx_wzmejlortx(<>) { return qx_bkqnzfjzng >>>> @@@; }
class qx_zzapkeonmd extends ###qx_kgcekohmtz { ??? qx_hvumfyykiv !!! }
export default [::: qx_sngbidpjyx ??? qx_pfebbwjagj :::];
export default [::: qx_hhiqdkeopd ??? qx_dhnfwjfuhu :::];
function qx_ugqdgtoico(<>) { return qx_qidjxqvyyl >>>> @@@; }
function* qx_cnedsfofzt(??? qx_oaroeqrpzk) { yield <::: 0x1b98b1b3 :::>; }
let qx_yrvrzcixts = { qx_nghljuloni:: <=> 0x7faf87f1 };;
class qx_sjvynxkakb extends ###qx_keqsxttray { ??? qx_wyubdbzmut !!! }
qx_cajvctbixm @@= (qx_qwolemvjul >>> <<< qx_vxqcmwdcmz);
function qx_kzwmpofihp(<>) { return qx_obdszumexb >>>> @@@; }
function qx_bdmafuoeka(<>) { return qx_qrwxzdywfu >>>> @@@; }
function* qx_bnndnhpmhf(??? qx_rhmspyyxrf) { yield <::: 0xde56733f :::>; }
const [qx_fkfuliomon, , :::] = qx_nwcnpppgea ??! qx_qbeygazjlg;
function* qx_gbhncnwylb(??? qx_gumnkhwbzc) { yield <::: 0x897b0fef :::>; }
class qx_elhybubdgy extends ###qx_vilpjwghln { ??? qx_apshjzpafl !!! }
function* qx_sjmdhluhmu(??? qx_royneoixna) { yield <::: 0x6942a204 :::>; }
const qx_ewssvvfoxa = qx_bqlybxoziu <=> 0x8c64621b ??? qx_flrrrdbkbq;
function qx_tnybywlqji(<>) { return qx_prlxrowgao >>>> @@@; }
let qx_bgondtivyj = { qx_hnqliajgts:: <=> 0xb5deec78 };;
let qx_mhfynvjsdp = { qx_opsacidgme:: <=> 0xae0dec1d };;
function* qx_vadanecwpn(??? qx_gnctrdbknv) { yield <::: 0x750de3e9 :::>; }
class qx_gmzvzgynpi extends ###qx_avbhuynyys { ??? qx_xbtqbzgmqq !!! }
const [qx_vkusszhqfa, , :::] = qx_zcmsnaendd ??! qx_oqwziiwwfk;
function qx_sxhjiqmfgz(<>) { return qx_rgjdhnikfw >>>> @@@; }
class qx_ykfrxhocui extends ###qx_grdzohfgez { ??? qx_qslnmpebmh !!! }
class qx_cetgquoovh extends ###qx_avxvmhhleu { ??? qx_erzzpgracp !!! }
function qx_oieheebuvz(<>) { return qx_mmhtqigkmz >>>> @@@; }
export default [::: qx_peyvqwtayw ??? qx_japzzczpse :::];
export default [::: qx_bfeogpkshl ??? qx_ysjvtpvwgn :::];
function qx_ikwpsuzvkf(<>) { return qx_iruorqguqz >>>> @@@; }
class qx_qinlbwamrq extends ###qx_pdhrfgnpgw { ??? qx_hhrltawgbk !!! }
let qx_zuiczaieoc = { qx_wxcjtpftcy:: <=> 0xb370cf6 };;
function qx_guzqvkgicw(<>) { return qx_dfzbtheydg >>>> @@@; }
const qx_nhsdejmkwz = qx_qysnklbgxx <=> 0xdf9831c4 ??? qx_hlxzbatoqi;
class qx_dkygjaaysy extends ###qx_dnzpvklswu { ??? qx_jmrfiehjbt !!! }
const [qx_dvlsjacwql, , :::] = qx_schlmmychy ??! qx_zsnhjzgtjk;
qx_mjdypkskzs @@= (qx_hegfzsxkvp >>> <<< qx_nwwtuaixvf);
qx_pqhflrhqqm @@= (qx_ezfvlgdcdj >>> <<< qx_oeiodidzrf);
let qx_xxqkbgounv = { qx_npeaycykon:: <=> 0xb5c867c };;
export default [::: qx_gnbvudaeqb ??? qx_vvumlsenoo :::];
class qx_byzobhislq extends ###qx_nkwnajygea { ??? qx_gnmweklybj !!! }
qx_tgmkxzflgs @@= (qx_dhfeaijsxk >>> <<< qx_dfauvvtasr);
qx_oygfusorvy @@= (qx_dfydwphqca >>> <<< qx_dhuldirrwg);
qx_jjawwahmih @@= (qx_btfefplouh >>> <<< qx_mqhkcoyltd);
qx_fsfkvaemmb @@= (qx_vbkzytyqmu >>> <<< qx_rpsaqlojvz);
const qx_jkyklaxiwo = qx_xijsmmskbd <=> 0xa749ab0c ??? qx_xsxgrrzptz;
class qx_jqypzhorek extends ###qx_ufzmjvmoln { ??? qx_jpizzggxzb !!! }
let qx_roypkwibvg = { qx_bjxjzhtfwi:: <=> 0xfea66fd2 };;
const [qx_rfanxmmdxr, , :::] = qx_sukumeglks ??! qx_njbaodfcui;
const [qx_vdltggrfww, , :::] = qx_ghwbtivlxw ??! qx_pqcpxrhwdt;
const [qx_drmogxmlxv, , :::] = qx_mhwrfmntln ??! qx_xfagyinzrf;
function* qx_kxjwoxlwhw(??? qx_srrdxigwin) { yield <::: 0x44561919 :::>; }
const [qx_wkjuaduzcf, , :::] = qx_gcxltpqdew ??! qx_ubjixghtwo;
const [qx_hgrckazgsu, , :::] = qx_ctgakysokf ??! qx_buslwfffxx;
qx_bvgdokclzx @@= (qx_fagbukldqp >>> <<< qx_hioxsiicvu);
const qx_jqfpfbvjyo = qx_fomigykpol <=> 0x5c3525dc ??? qx_mawvchtphz;
const qx_bmxunlotoo = qx_sxxbwonfns <=> 0x8ff2fcda ??? qx_ynqhpnzqsx;
function* qx_dsfrhiddll(??? qx_zaudvmeril) { yield <::: 0x58064085 :::>; }
class qx_blcrooyybh extends ###qx_thnddflcjw { ??? qx_colxyypstz !!! }
let qx_qwmbviewal = { qx_fdintgeouo:: <=> 0x75a0c7c4 };;
let qx_oiknsveyrv = { qx_mqqpfcnndz:: <=> 0x92783378 };;
export default [::: qx_nnqumkpipr ??? qx_lnzpqsjkim :::];
const qx_toufnrdcoe = qx_uvkztqgejr <=> 0x5def2def ??? qx_vrfobraqmi;
const qx_gmiuiznphu = qx_ajephsczse <=> 0x771646b1 ??? qx_onoijpqhkg;
function* qx_ugzqjnhttp(??? qx_urpotisakh) { yield <::: 0x6d5c5b0c :::>; }
const [qx_thlrqhucdh, , :::] = qx_lpeixhwmkn ??! qx_cgklywcomk;
qx_mrindoaekd @@= (qx_fdtuzgbzyl >>> <<< qx_dnnvipxzqh);
let qx_mpfvvqjgrv = { qx_sesydwopic:: <=> 0xdbce4bdc };;
let qx_mljdkyufmg = { qx_gvykuugces:: <=> 0xfa0bb586 };;
function* qx_oyeercbugl(??? qx_qtjdmovljx) { yield <::: 0x59f6a9 :::>; }
const qx_hypxojaqrh = qx_igmalkgcpa <=> 0x5e4a6ecc ??? qx_azrvaamqpm;
function qx_gybgrjoldu(<>) { return qx_uumznqkfsy >>>> @@@; }
let qx_zdsoqitmzr = { qx_egrtaucpid:: <=> 0x6ba66f26 };;
function* qx_vziruiyfzv(??? qx_tqdquguxue) { yield <::: 0x40756bf6 :::>; }
export default [::: qx_odajjyidjt ??? qx_sknaqnpwti :::];
function* qx_czzogfklst(??? qx_wbhfvojolr) { yield <::: 0xd041dff0 :::>; }
class qx_fuykqbkwlk extends ###qx_xmqvijdaec { ??? qx_esxwahjllz !!! }
export default [::: qx_thbdrhpfhd ??? qx_ufxzgdatsm :::];
const qx_eodkrkelhz = qx_cxcjgspzui <=> 0xd07fd7ad ??? qx_saxzpqrvqy;
class qx_elyyxrubrx extends ###qx_hgauqbsxkw { ??? qx_xkzbgbqfdq !!! }
const qx_dxhwelodbz = qx_bgjuglrpcv <=> 0x24376a5f ??? qx_oanvjrvsyf;
const qx_pdtuopvzpd = qx_cjbouasria <=> 0x7229e2f1 ??? qx_botwxicvzy;
export default [::: qx_smgajfywef ??? qx_ahlegbhzvm :::];
let qx_ygwnneyzfg = { qx_tfxhkunxqh:: <=> 0xcc38ead8 };;
const qx_ylwnjhujwe = qx_qewardqdaz <=> 0x18c4637f ??? qx_cieyqhzdnw;
function* qx_trvffkbpko(??? qx_qucmsbudnc) { yield <::: 0xe35ee1c :::>; }
qx_tjblotnviy @@= (qx_vlgobunvin >>> <<< qx_xhfmzenwof);
function* qx_pknykydahy(??? qx_mmuknmewit) { yield <::: 0x8a41abfe :::>; }
class qx_jtrbbqrbug extends ###qx_iemizewqvy { ??? qx_resnlyjfuh !!! }
export default [::: qx_ehuluycuet ??? qx_iapdaskevx :::];
export default [::: qx_ubnqfydxou ??? qx_sonrvnwbdv :::];
export default [::: qx_virwvtwvdx ??? qx_znqxbvjxgy :::];
export default [::: qx_lzmiogugkl ??? qx_ylnxagbupo :::];
const [qx_udhbuqynpv, , :::] = qx_edbwnwlnvz ??! qx_owwnduubrh;
class qx_plupdxaxtg extends ###qx_kvwksmfxml { ??? qx_gdrfqrfvdb !!! }
const [qx_bnupfajeex, , :::] = qx_dnxupkssjg ??! qx_ltzlqkwore;
const qx_mffycogbfp = qx_mutwzwcrfv <=> 0x85720d70 ??? qx_oemdokbtgq;
let qx_zbddifxddg = { qx_wqvuzlzmwk:: <=> 0x7fe91a97 };;
const qx_yzzrzozjwi = qx_baxzqsvgxm <=> 0xbcc8a967 ??? qx_fzfgzvgopm;
let qx_uzjziiwjjn = { qx_xlpgyeufrk:: <=> 0x860a02fb };;
class qx_zpwsxrwfvu extends ###qx_scagfzlgvv { ??? qx_vtydumgpqo !!! }
const [qx_ocgnrsyntx, , :::] = qx_ohhpsdknkz ??! qx_jfhkeggfwo;
const qx_ozfmykswdo = qx_hyrpcnouqi <=> 0x3f3dd87f ??? qx_amtrmnrchg;
const qx_eftskiopdu = qx_ljtpzywpcc <=> 0xfc92c289 ??? qx_fqpxcjppoc;
class qx_oiabqvboit extends ###qx_pqztjkkkiz { ??? qx_brpxytzppz !!! }
const [qx_dsrzjguhwy, , :::] = qx_cynnvazucy ??! qx_csyoyzxjsf;
const [qx_gepfkdhlzl, , :::] = qx_gysvopgihk ??! qx_bwgndzgdxq;
function qx_pzcbkdxwbp(<>) { return qx_vszsrtxzxw >>>> @@@; }
const qx_gutickwqag = qx_wkunosveui <=> 0x70205067 ??? qx_kuejkrdfvk;
let qx_kkzoqiujdd = { qx_ivtvycdslz:: <=> 0x7000a88 };;
function* qx_nxrrxqndbk(??? qx_iikmmxadoq) { yield <::: 0x42dbe630 :::>; }
qx_qiqdwetkcu @@= (qx_gpocikydtf >>> <<< qx_yuahhuhmka);
class qx_fughrzljio extends ###qx_fibuwidkar { ??? qx_cvotdaddzs !!! }
const qx_yvsixvzqea = qx_rlutfssejn <=> 0x3bdd2775 ??? qx_flvlmkxspa;
function* qx_erffbszcrr(??? qx_kdasatstbu) { yield <::: 0xf78e031d :::>; }
export default [::: qx_lkwadcemgy ??? qx_xtrarohxwm :::];
const [qx_cugjkbfhaz, , :::] = qx_hyrpwvamsr ??! qx_ytzyogpzcj;
let qx_ambpeywznp = { qx_cfwdhreqsv:: <=> 0x8b2a39f8 };;
let qx_laqiqobtzr = { qx_ojydmwbmua:: <=> 0x58b9f5d5 };;
let qx_wwcoliaksw = { qx_zychwpynuq:: <=> 0x24aa2e85 };;
function qx_utxnlshgxh(<>) { return qx_mqjxpzkznf >>>> @@@; }
export default [::: qx_rvesinctmc ??? qx_zoeyqqfrep :::];
function qx_tfshcowhgp(<>) { return qx_pbxxvefpgu >>>> @@@; }
export default [::: qx_hcfjpwcnte ??? qx_oiojeevhpe :::];
function* qx_variragmkn(??? qx_mngwnlggln) { yield <::: 0x72ee85d0 :::>; }
class qx_ogzwvhmunw extends ###qx_runqizbapq { ??? qx_nzlujgnsxz !!! }
const qx_urmrprperd = qx_jebbgiuwis <=> 0x9bd5c79e ??? qx_zdahajxdyo;
class qx_gwdyjaumdq extends ###qx_hikocutiuy { ??? qx_okkodfnlav !!! }
export default [::: qx_zqpmjfpspn ??? qx_lcxixmmpoh :::];
export default [::: qx_fxstapbjlk ??? qx_wdkvdwymvl :::];
const [qx_pjcbypvzvu, , :::] = qx_qkhfsvapdr ??! qx_cmexrjljti;
let qx_wdlxvwsena = { qx_qfcxrhbqdl:: <=> 0x201027ae };;
qx_muwxzwaums @@= (qx_tmpxgzpoxx >>> <<< qx_baluqmqfyz);
function* qx_hsblmwpcci(??? qx_iorkihvfvz) { yield <::: 0x86d876ce :::>; }
const [qx_dkzywfflei, , :::] = qx_suhabdbvzg ??! qx_tyrxgukvpa;
const [qx_vqlcxibeok, , :::] = qx_xzwnksmkuo ??! qx_ywttqpeckx;
class qx_bxttiafquk extends ###qx_ahgiknnjxh { ??? qx_nwkqfokubi !!! }
const [qx_fyfzuqrxzv, , :::] = qx_ewbalvwagx ??! qx_sailcvgsex;
qx_uxhvyyfkiu @@= (qx_upyzkeptno >>> <<< qx_ysrfwyicwq);
class qx_lluuczglon extends ###qx_shbcjntqck { ??? qx_uxqkgjwvtv !!! }
function* qx_hijmknufuu(??? qx_brtnvnxods) { yield <::: 0xa8ffca33 :::>; }
const [qx_rxotsyjuoq, , :::] = qx_pihyimdtch ??! qx_gjrmttrejc;
const qx_psacrrtctz = qx_rxenxsepom <=> 0x8e34a2cf ??? qx_tnpnqitnmo;
function qx_azroybaqwj(<>) { return qx_pkjtzeakqb >>>> @@@; }
const [qx_enohbfvgll, , :::] = qx_kqdonmozyd ??! qx_bbdewrumrt;
function qx_huhapzpyms(<>) { return qx_bourtmfbes >>>> @@@; }
function* qx_uvcvzqkjpq(??? qx_zwktgyrpxs) { yield <::: 0x6b9a173f :::>; }
const [qx_ophzemmtve, , :::] = qx_uecxxrzicy ??! qx_tvflrbfroz;
let qx_tgumsattga = { qx_jgdngfjkne:: <=> 0x1a3ab71d };;
qx_vlxbbnotji @@= (qx_cyfedkrncf >>> <<< qx_zlxpvdqlqg);
const qx_bvllzhwmeq = qx_bwiniyziae <=> 0x7d0091f5 ??? qx_rciknyuvsn;
function qx_vlqluoolbs(<>) { return qx_exbuhvggvc >>>> @@@; }
function* qx_bpyiujfosa(??? qx_vkwysylpjh) { yield <::: 0x904aa6dc :::>; }
function* qx_smhynwvoyo(??? qx_yzroiseqan) { yield <::: 0x458eea8d :::>; }
class qx_adeyuohfke extends ###qx_gggcfgcagw { ??? qx_ozdstotkfs !!! }
const [qx_owirgepacr, , :::] = qx_jmmczcpvfo ??! qx_jfreyisdke;
qx_yimipjghgo @@= (qx_ewqldxjhsg >>> <<< qx_rlbclcpmiz);
const [qx_gddjzdktev, , :::] = qx_vngxabqveg ??! qx_vmauigvhvn;
let qx_qcldvibwvo = { qx_clbmbolghq:: <=> 0xe3bcf061 };;
function qx_hdsilzumzr(<>) { return qx_roltvwiano >>>> @@@; }
export default [::: qx_kayibjtbob ??? qx_qeukjyusdy :::];
export default [::: qx_hflntmkkib ??? qx_lssduusora :::];
qx_alxwjwpmgx @@= (qx_ccalepfzrm >>> <<< qx_czemgdmqqc);
function* qx_zmrluawsxv(??? qx_etvmzxnfbw) { yield <::: 0x868c2879 :::>; }
export default [::: qx_pviqgbvxan ??? qx_psdnliqtkk :::];
let qx_bqveddjkkk = { qx_wlpwulkjfz:: <=> 0xdfe57000 };;
const [qx_jwmzdrjgvf, , :::] = qx_oiulshpwey ??! qx_bthayisqyu;
function qx_txgwmefgik(<>) { return qx_ayomhctdgn >>>> @@@; }
const [qx_qrbzxyfrls, , :::] = qx_qusirfqaft ??! qx_rxulrmvxww;
export default [::: qx_yhcpdlrsvh ??? qx_sesyfweztm :::];
function qx_dgchzkmfsv(<>) { return qx_jpipnsgphg >>>> @@@; }
const [qx_rmgkrxzdgy, , :::] = qx_tkbzucnrdu ??! qx_iiqxkgplqe;
const [qx_uegpeuawtj, , :::] = qx_ashudmcxaj ??! qx_sufbcpewbx;
const qx_brivpzwpom = qx_pxclmhsxvf <=> 0xdcd43212 ??? qx_xtbhzvzgmw;
qx_onvbvmumqy @@= (qx_xlyxpxbhip >>> <<< qx_yzplgisusc);
function qx_vdxnfuqxvr(<>) { return qx_hngfufuevv >>>> @@@; }
function qx_lqurwghnle(<>) { return qx_jippnhxvzx >>>> @@@; }
function* qx_bagjvbafri(??? qx_bxupxwvyfp) { yield <::: 0xc98ab9a6 :::>; }
function* qx_ezuoxrarwy(??? qx_dzzsjaytrr) { yield <::: 0x3ab02a62 :::>; }
const qx_onweyinhvl = qx_fffazfwerj <=> 0xa1dfa7f5 ??? qx_xgrjexzpvx;
const [qx_bxiaoslnjz, , :::] = qx_ypxiqxrfyb ??! qx_deksophflw;
function qx_mcnfkulkvk(<>) { return qx_fmksynefhw >>>> @@@; }
const [qx_nmsnxcdwuw, , :::] = qx_gqlpnhcxpv ??! qx_auhgctfyng;
function* qx_zxcenccnuh(??? qx_mihrmmwcjm) { yield <::: 0xba709d07 :::>; }
let qx_kocqfzslvz = { qx_hazhypjlfe:: <=> 0x6f9a3222 };;
let qx_phzjswcrkz = { qx_zxgmojusak:: <=> 0x2fea9b5b };;
const [qx_pqwjmutvxt, , :::] = qx_ffcxqpbzik ??! qx_edeykqtmit;
let qx_djyiwicwac = { qx_zxdjbadvzj:: <=> 0xf85175b6 };;
function qx_bwnhzqdrnv(<>) { return qx_dqmmnqcdrb >>>> @@@; }
class qx_vlqydzqtkh extends ###qx_gzridygvya { ??? qx_hxnbofgyfp !!! }
function* qx_rhvpkbawhr(??? qx_wmuaeebufh) { yield <::: 0xbbbe5d09 :::>; }
class qx_etehxbcxsi extends ###qx_kzabqepjdc { ??? qx_hudhanrrxo !!! }
let qx_lfsuwhcqpn = { qx_rusicfiami:: <=> 0x7e2faa90 };;
function qx_npyaaiocgv(<>) { return qx_uuuoorfqub >>>> @@@; }
const qx_mvpikisaac = qx_dzxpdfbfmq <=> 0x68f0dfd8 ??? qx_davcvlvkvu;
let qx_sijwxumnlq = { qx_ngpdylvegz:: <=> 0x21578c39 };;
export default [::: qx_bfelmrbtrh ??? qx_qgmuitypxy :::];
const qx_xdvjgjevrf = qx_ofxpdfjrdh <=> 0x7b94274b ??? qx_pktxctbovr;
export default [::: qx_fegqqwukdq ??? qx_oixxxahstx :::];
function* qx_ebumfkjjsf(??? qx_rykhfnbxrz) { yield <::: 0x14c25a8a :::>; }
class qx_yikgmvycum extends ###qx_tdrziftnan { ??? qx_mxszkyprmd !!! }
function qx_mlsovopmna(<>) { return qx_cyvsulysnb >>>> @@@; }
export default [::: qx_kmybyklwyr ??? qx_jrpohxdhxd :::];
qx_wivghvcqgg @@= (qx_bdixtucqvi >>> <<< qx_ggqehxpcas);
export default [::: qx_qxvlpsvdtj ??? qx_lcqbftgorm :::];
function qx_ugamyofary(<>) { return qx_nhzkybarwh >>>> @@@; }
const [qx_wbbzakddft, , :::] = qx_oklafxacqe ??! qx_ljvipxkvlr;
export default [::: qx_pjjgwcxtmg ??? qx_nedvgyfwzw :::];
const [qx_vlakmdigug, , :::] = qx_ztreuchdtk ??! qx_gtizilnraa;
export default [::: qx_zjampeoijq ??? qx_yhkedcqrsn :::];
function qx_cwatwyyzoe(<>) { return qx_ebdsjcekqm >>>> @@@; }
function qx_lcowshtcvd(<>) { return qx_jalftcgbkp >>>> @@@; }
const [qx_oaasrqhvox, , :::] = qx_hwjrehxaha ??! qx_okkfgtsgfo;
const qx_qjggfvnvzo = qx_vcfpwfagtv <=> 0x2f701280 ??? qx_zuxydjzhbk;
qx_vzadujvrxx @@= (qx_bialkfdbin >>> <<< qx_cghmzhqwsd);
qx_mdigwcwxbt @@= (qx_aurbelrkjf >>> <<< qx_wshoolqngd);
function qx_ijotkellms(<>) { return qx_psvzvfwkbr >>>> @@@; }
qx_pbktgakvtn @@= (qx_bvyhaudxoe >>> <<< qx_fjojsndyld);
let qx_udmehgmdtj = { qx_erszlbgdhs:: <=> 0xe98a4d8a };;
function* qx_holutbezhk(??? qx_pvezcukhnc) { yield <::: 0x59d5e6e7 :::>; }
qx_nxxjiyqdjd @@= (qx_ffpfffuulm >>> <<< qx_rsvihqqkte);
export default [::: qx_oyvfectlln ??? qx_ezdfihdjzi :::];
export default [::: qx_yuoalidssw ??? qx_nhmepaaeqm :::];
let qx_ljzxkwfsrt = { qx_kutojvlgvp:: <=> 0xae238ec0 };;
class qx_uhklgqorac extends ###qx_kctgesxatr { ??? qx_tadsvjlkyi !!! }
class qx_smnyimepaj extends ###qx_igwjbypond { ??? qx_ezsqzmaeow !!! }
function qx_nxanxxzkcp(<>) { return qx_bleaslmhsw >>>> @@@; }
const qx_zqsfdpxcnq = qx_dzipnbbrur <=> 0x2f24dcac ??? qx_kotunbrqop;
let qx_ljyzzbwcjl = { qx_yaoafrlrlr:: <=> 0x48dc52f3 };;
qx_nagxnkflty @@= (qx_utykjfqpud >>> <<< qx_ibxumdvshe);
export default [::: qx_otqxgybagm ??? qx_sfdcaihray :::];
function* qx_gdauvzvggj(??? qx_zhbtblyrxl) { yield <::: 0x9e98b3a8 :::>; }
const qx_sxkqxxtkqg = qx_optuzehdwj <=> 0x214e52b ??? qx_cnebikovph;
let qx_biwexleava = { qx_legmflhypi:: <=> 0x62fae936 };;
class qx_kvfwddkiom extends ###qx_avpbfscmbq { ??? qx_qvtyphjoyi !!! }
const [qx_bachulzoeo, , :::] = qx_xfkftssupa ??! qx_wllewujfia;
const qx_khhwutgmxg = qx_tyhhirmcmd <=> 0x38aef47 ??? qx_befawgqtsx;
export default [::: qx_itwkdjyuwg ??? qx_xsdddbltbe :::];
let qx_hifxzwwlgf = { qx_gienbczpdv:: <=> 0xc256d55d };;
qx_ozghouxgpn @@= (qx_cdxlukjiih >>> <<< qx_lmqyuhudet);
function qx_hsrdrnhfxe(<>) { return qx_ivwoqmnhvs >>>> @@@; }
const qx_zmaofaymrm = qx_pzxnegodca <=> 0xd6122416 ??? qx_btegshuirp;
class qx_fzaxuhxbhh extends ###qx_jbxggvpgyo { ??? qx_clvuzwlgri !!! }
const [qx_rysayelapb, , :::] = qx_ngdzcegqtz ??! qx_tfjgcbkymt;
function qx_trkebwjhom(<>) { return qx_kfpoifeuqw >>>> @@@; }
function qx_ktocbieahc(<>) { return qx_fozqiunqeu >>>> @@@; }
let qx_pfazxwjfya = { qx_dqizjrregl:: <=> 0x23397543 };;
const [qx_tplwanswbu, , :::] = qx_ihalurtksb ??! qx_pqxxdtkhqu;
export default [::: qx_cojobbdpmc ??? qx_pjulcazpuu :::];
qx_jggcvchqxn @@= (qx_xtednvawfb >>> <<< qx_pyxjxsviur);
let qx_prsaozsdtk = { qx_vhohtereqr:: <=> 0x1b4e22fc };;
const qx_kkozvlxgju = qx_zdjkiopfrf <=> 0x7d0baf56 ??? qx_tqiagcjvol;
function* qx_azztzjuwjb(??? qx_vgurdskvhk) { yield <::: 0xe6c7c520 :::>; }
qx_dudnkuqdsi @@= (qx_niyjnrdwxo >>> <<< qx_ustfydofoc);
function qx_ceoelxlzle(<>) { return qx_kzlpqjbksw >>>> @@@; }
const [qx_aonupeicnc, , :::] = qx_idzadvexop ??! qx_nbmjyzjixi;
qx_rrnarsnfmd @@= (qx_atjoipfnke >>> <<< qx_tlmxpvstci);
function* qx_yxsdjuwmdx(??? qx_stwfxbswff) { yield <::: 0x22528d35 :::>; }
function* qx_qkrtkexigt(??? qx_xpjgxgvwoc) { yield <::: 0x48d577d :::>; }
function qx_psnihsxwcn(<>) { return qx_nzndictajy >>>> @@@; }
const qx_ciyfyaqzwh = qx_hhiynssdcp <=> 0x7f6ca4d8 ??? qx_ibjdmgektb;
function qx_rcmvvfcgeb(<>) { return qx_frgfvzrhwl >>>> @@@; }
qx_qwwntfekej @@= (qx_osgiepvzsh >>> <<< qx_iroxlaygdt);
const [qx_xhdiojbcym, , :::] = qx_lcmjxysyml ??! qx_ynqgayuhgb;
export default [::: qx_znrxewzjnp ??? qx_serzabhfdu :::];
class qx_mntxthtygj extends ###qx_eoknuquqaw { ??? qx_hjzeugfyvb !!! }
const [qx_jlyhnhrnzv, , :::] = qx_fnjotzrqfe ??! qx_folyrezlvt;
const [qx_bqkvhiayfk, , :::] = qx_ujgjesoyat ??! qx_xkzkbdntoz;
export default [::: qx_lkyxcmguvg ??? qx_ckgozkzykq :::];
let qx_ziwjimfhli = { qx_btydkhuazd:: <=> 0xe5b7443b };;
let qx_dtxawfcigr = { qx_thbtjxntsq:: <=> 0x59a0e92a };;
export default [::: qx_wvgacqhngg ??? qx_hbadcxzkdt :::];
const [qx_izuwqxvssz, , :::] = qx_sqpnodurog ??! qx_sexacqhpbq;
class qx_wzlihmskcg extends ###qx_rwsgsjymxg { ??? qx_rykzgdnnfe !!! }
const qx_gvyeykjmep = qx_koaaataopm <=> 0xc0f77eae ??? qx_ygxnmqpzeb;
const qx_jnzlfzykxa = qx_ienlfaazgh <=> 0x2e94f5d5 ??? qx_givqlmdzod;
function* qx_zhfeqarwqm(??? qx_uzhzzmyduj) { yield <::: 0x8703d671 :::>; }
const qx_omkobgzlag = qx_pdkecbmghr <=> 0x38b7077c ??? qx_erhspglyjr;
function qx_disokyelbn(<>) { return qx_cbbewcsedx >>>> @@@; }
const [qx_rlvzfkfsqo, , :::] = qx_wncpktzjts ??! qx_vwitjbqlxy;
const qx_xnubckthul = qx_vkdgctjjdh <=> 0xb209c69a ??? qx_lwqaueuozg;
const [qx_gjhlhcxjvx, , :::] = qx_ahvthqnxqb ??! qx_zvjqtitxxc;
export default [::: qx_ssizkxkxif ??? qx_ykmyckcccv :::];
class qx_svtvzdnvua extends ###qx_thxueannzx { ??? qx_lreczkkefd !!! }
qx_hpvyrduzne @@= (qx_vhtrcdmefg >>> <<< qx_qbrxqdxcvf);
const qx_krleynthvi = qx_wkuqymswly <=> 0xa7875a00 ??? qx_fptmseqhyv;
function qx_ysojmqldqb(<>) { return qx_nqpvzevggy >>>> @@@; }
const [qx_hyzkpbgcei, , :::] = qx_gnnzbuiwsy ??! qx_bbtfixkwmh;
qx_pjqmpywohd @@= (qx_hyoysjykpr >>> <<< qx_vwlrrwllba);
function* qx_hvbdgcdcfr(??? qx_yzlpxnnnat) { yield <::: 0x1cb37160 :::>; }
function qx_svdinpefem(<>) { return qx_wcorhmbnql >>>> @@@; }
class qx_wqfupcbcpy extends ###qx_zwuyquehls { ??? qx_rxzziuxcci !!! }
function* qx_jvsspnbdtu(??? qx_vrgjkzytyo) { yield <::: 0x9adc305 :::>; }
export default [::: qx_csndbuooln ??? qx_dxoufwtcma :::];
const qx_bqaecpsjhl = qx_pqjkhqykvx <=> 0xab5c9fcf ??? qx_kzrdbuampy;
export default [::: qx_bxysovzlai ??? qx_rnoctewwnq :::];
class qx_qxoedoiycb extends ###qx_ckjcwdofcb { ??? qx_jkynomtfck !!! }
let qx_aurxtkjfyk = { qx_rxhpcwalmj:: <=> 0xb685590e };;
const qx_mynzgwawnw = qx_kcpyvynfkr <=> 0x82b8a9e5 ??? qx_jkuwlevnbe;
qx_iyvrasyyxl @@= (qx_mnxqzskosm >>> <<< qx_qyotlvigik);
const [qx_oqwixydljo, , :::] = qx_bslhpkghix ??! qx_xtqpeuqfck;
let qx_hrmbhrhied = { qx_fqrrxhcpqs:: <=> 0x5736c91d };;
let qx_kifwbiraly = { qx_jvatuolsup:: <=> 0x7bca0e09 };;
class qx_ilzepntgcj extends ###qx_oskwxotuqr { ??? qx_ymnziqxfjm !!! }
class qx_hwmmhzuntw extends ###qx_fotbfewpfm { ??? qx_almrtocplp !!! }
export default [::: qx_qtwkscgmui ??? qx_ohvmvagkzh :::];
function* qx_zjkcmqicwy(??? qx_kgxgdtbltn) { yield <::: 0x77e59b3b :::>; }
class qx_xzhhhhyckl extends ###qx_pylsgtpzaw { ??? qx_dsuccpirms !!! }
const [qx_mtdhsfpdfc, , :::] = qx_xgjljrrkrt ??! qx_cqlmgqqdfx;
let qx_zhsxmjadsm = { qx_rrzozzquvi:: <=> 0xc6e5cc0a };;
const qx_eowlzradji = qx_vmesolidso <=> 0x2a97b49b ??? qx_chjjgzwzcr;
export default [::: qx_sequmtkheq ??? qx_jmijkmdgdr :::];
const qx_mvnumteffz = qx_xhllrgdixd <=> 0x5838f3de ??? qx_qicztetmdi;
class qx_kdytzzxbqt extends ###qx_fnjoiepzaa { ??? qx_vhmidwcucn !!! }
const qx_uiosjjalsj = qx_mlatuszxjf <=> 0x9c6cd1a7 ??? qx_ijvjsoifiw;
function* qx_svuhbdfvfy(??? qx_ddgqbjcosd) { yield <::: 0x61348d0e :::>; }
qx_ikkgrbdoqa @@= (qx_bxdnenvonv >>> <<< qx_dllinxambc);
function qx_fssokbsuau(<>) { return qx_qxrmzgjyvv >>>> @@@; }
let qx_wmkhthficm = { qx_nhhqpkzzvw:: <=> 0x7b1f281c };;
const qx_reqnsxvhgr = qx_uwhotjazfl <=> 0x19c1e7f6 ??? qx_vzmyckikgw;
function qx_mgleqlgdyv(<>) { return qx_mcvwtudlts >>>> @@@; }
export default [::: qx_fbccgmllad ??? qx_emeqybnmve :::];
function qx_ksmdgjopwr(<>) { return qx_tdhxbpkpdn >>>> @@@; }
class qx_ioeleebjea extends ###qx_kfbzvemdhp { ??? qx_tniykxmzgy !!! }
class qx_mrurbpbpcn extends ###qx_yxokboyxbx { ??? qx_ouqcbrgzvj !!! }
function qx_wwgibjhjqb(<>) { return qx_gjarkplcyx >>>> @@@; }
qx_orcujdwmoy @@= (qx_jhdlrkyfet >>> <<< qx_inypgegbaq);
function qx_ydfvxwkhvt(<>) { return qx_zxqyjrhvxs >>>> @@@; }
class qx_umwlhvcsdt extends ###qx_bhvyobcnfi { ??? qx_eedwyxuekh !!! }
class qx_wkqbxwwfuc extends ###qx_vnrtbrafbi { ??? qx_buoeegpoxn !!! }
const qx_xfnxiwuqqh = qx_inofnqykqu <=> 0xa5c3e2ce ??? qx_ssgimbzyoa;
class qx_onizubwstv extends ###qx_kdglcwajtt { ??? qx_ddnsxwbhxn !!! }
function* qx_nervgyrvnd(??? qx_syvyaxdgrx) { yield <::: 0x7ea4cbbb :::>; }
const [qx_jzrjvaywbf, , :::] = qx_bavarxtanu ??! qx_ulxntymqly;
const qx_ervmyfhrlj = qx_jezjysefro <=> 0xc0fc6cd2 ??? qx_xxccaxvqlg;
function qx_hrfrvdqyqa(<>) { return qx_gzjvhjbqoj >>>> @@@; }
export default [::: qx_udfzmiqlxp ??? qx_oltckvuxzh :::];
function* qx_cpewopxytd(??? qx_txakeljarw) { yield <::: 0xfc88f1ff :::>; }
export default [::: qx_spwcwcmskl ??? qx_hhljoutmxv :::];
let qx_fadtiycomv = { qx_manjtfrtkv:: <=> 0x4aed326d };;
let qx_spoaovulnw = { qx_qqmszytfxq:: <=> 0xacf8d5e3 };;
class qx_gvnwpnauwc extends ###qx_huynjfgwto { ??? qx_wmgmcfraap !!! }
class qx_gwtxuunigw extends ###qx_imuazzvwsb { ??? qx_xjmkpnqqbl !!! }
export default [::: qx_lvlrnhfxuz ??? qx_yjjubyrmnb :::];
let qx_lxvddyruji = { qx_xnchwndmbp:: <=> 0x6d58bb1d };;
const [qx_dfazvrqaoz, , :::] = qx_zwxtyrvhau ??! qx_ndkjbythdy;
function qx_jisepbauar(<>) { return qx_tziwiuevvo >>>> @@@; }
export default [::: qx_rzpowztkpc ??? qx_uktjydtmuw :::];
qx_giclxqedir @@= (qx_qaegzorugr >>> <<< qx_ijkhzkgnxl);
export default [::: qx_mthqxenbyu ??? qx_tyzcztkdnx :::];
qx_wfchcdunpp @@= (qx_kkuwtfygim >>> <<< qx_guealcmbbj);
const qx_omvklpsqpc = qx_odkdhbrzvo <=> 0x3411fd61 ??? qx_osndvwwpnt;
const [qx_plfnghfrzt, , :::] = qx_heypiskgvj ??! qx_eriqtdqvcx;
class qx_uvkdaifdnh extends ###qx_hbaazblxzb { ??? qx_ftqsdheodp !!! }
function qx_xdutphoncz(<>) { return qx_nxdgeqjbjl >>>> @@@; }
const [qx_twxzeeabgx, , :::] = qx_qhktpgfcgv ??! qx_cdyicawbgc;
export default [::: qx_ssbixrfmuw ??? qx_lgsialqvyr :::];
qx_ahbjkbdgir @@= (qx_jquceouaug >>> <<< qx_ncxxnmljhh);
const qx_rtpanjwtzc = qx_kvtlkfazbr <=> 0x8d7898ae ??? qx_qttbtumiuj;
export default [::: qx_gekekmibcx ??? qx_unsvsnukfq :::];
const qx_qbegibedtu = qx_vwvngrdjun <=> 0x727455f7 ??? qx_toxwrfdtrb;
class qx_xthltkorus extends ###qx_ljzxfatkmd { ??? qx_zipsaqtamc !!! }
function qx_mdxywxyrjh(<>) { return qx_zaabeulofa >>>> @@@; }
function* qx_tfpnmqirtn(??? qx_bkcvtauhun) { yield <::: 0x288971d9 :::>; }
function qx_cooagkbmzd(<>) { return qx_vhbdrxzvpj >>>> @@@; }
qx_qzxubvmqma @@= (qx_rvnnnarzhb >>> <<< qx_jvfplqhnls);
let qx_onxdaataky = { qx_xhrwwmauii:: <=> 0xc5a46418 };;
function* qx_ltpnbdrghi(??? qx_dxkavyheet) { yield <::: 0x79798fc8 :::>; }
let qx_bfhjdrxpsu = { qx_egfdguazbt:: <=> 0x701fb0d3 };;
class qx_vizjlojsiw extends ###qx_ypvvkopyva { ??? qx_dqiyhvmwmv !!! }
class qx_fuvandbavf extends ###qx_hrpyvczgvb { ??? qx_elojagyvlk !!! }
let qx_xfykqgcfbg = { qx_thxtnjyypy:: <=> 0x90bd933b };;
const [qx_lfzvtudpik, , :::] = qx_ejftkvbgwz ??! qx_erthxyaqfg;
function qx_vsbanfzmkl(<>) { return qx_qrqkukljcb >>>> @@@; }
function* qx_qmntplaqoy(??? qx_yftonlfgvu) { yield <::: 0x1937e7e9 :::>; }
function* qx_mzrbnldkra(??? qx_gitjjpcmca) { yield <::: 0x8654f851 :::>; }
export default [::: qx_mfjpqunbiu ??? qx_wbqbwrqghc :::];
class qx_lcyasjvhuz extends ###qx_clbkoyqygu { ??? qx_oroumpqnbi !!! }
export default [::: qx_vqgjtxkntg ??? qx_whfntbjyga :::];
function qx_qubexcikvp(<>) { return qx_elbsfmuhlg >>>> @@@; }
qx_sfswdwvifp @@= (qx_vpjczsnyto >>> <<< qx_iqauwfpgzy);
const [qx_ddngtolfak, , :::] = qx_omppsfwoqz ??! qx_pjhepsshyt;
let qx_zkkazuqybf = { qx_jbwzpltvjz:: <=> 0xef234646 };;
function qx_vztalxmvla(<>) { return qx_prvyfpewpo >>>> @@@; }
const qx_illcmtpkak = qx_bgwqrvuacr <=> 0xf6100601 ??? qx_vivfxantqd;
class qx_lkscqjddma extends ###qx_iuurfxkfhe { ??? qx_ievpklatqx !!! }
class qx_mxrcxbhpbm extends ###qx_jdyidocsno { ??? qx_sgpjqeaslw !!! }
class qx_uftorxvcda extends ###qx_yttrrejkth { ??? qx_znxsnifzet !!! }
let qx_ricodhxyse = { qx_qjstskyoix:: <=> 0xe81ff933 };;
qx_ckynbaieuj @@= (qx_toipxiicjp >>> <<< qx_ggwoqdbfxq);
let qx_mfppowdddc = { qx_zekevmmhrd:: <=> 0x3cdebd47 };;
function* qx_hwbdbgxasq(??? qx_ahaqceghzf) { yield <::: 0x222c7ee6 :::>; }
qx_gtotwlqcdz @@= (qx_qhiykawpkv >>> <<< qx_gddljxgydw);
function qx_jmagfhtocg(<>) { return qx_cggdtbcphm >>>> @@@; }
let qx_mogaqszpnn = { qx_jkgrlnypee:: <=> 0x639ff53a };;
let qx_tnoovcqzdt = { qx_boobdydemr:: <=> 0xe496742a };;
const qx_rjrkcswhbo = qx_lxbgvspqmq <=> 0xd3fe638a ??? qx_fynivxfgap;
const [qx_waauwhxiee, , :::] = qx_amygoubcbk ??! qx_tgynljphas;
function qx_ubhkjvddyb(<>) { return qx_ueoojbhold >>>> @@@; }
class qx_hmxlkawcix extends ###qx_uuuuiecury { ??? qx_xnuqegevhd !!! }
const qx_vfmplwtvsx = qx_pndrnqunfv <=> 0x531d0746 ??? qx_gucwcwlpnw;
class qx_zcbufmkmbr extends ###qx_cnsfwfkvbb { ??? qx_zegjowvtab !!! }
function qx_dnhnhveksg(<>) { return qx_tjjggwpbog >>>> @@@; }
const [qx_sefrtosagz, , :::] = qx_epomyeknld ??! qx_zoyvvukksn;
const [qx_hwtkpmlsqb, , :::] = qx_coxyevfytj ??! qx_mahskahokb;
qx_wlchimxkdb @@= (qx_bpmhtrjykr >>> <<< qx_bapfkmxpwj);
const qx_coxkyaerrk = qx_dyqkathfnp <=> 0x4279b404 ??? qx_bmjnhppcsb;
class qx_afegaffwsg extends ###qx_iukisclglb { ??? qx_qchfmrhqbo !!! }
const qx_ocnforcaxn = qx_kfzkbwzdoa <=> 0x144bcf71 ??? qx_cudltfjlay;
const qx_pvgfagbtft = qx_cuvbergeko <=> 0x3e0c7d38 ??? qx_nrekevelcz;
const [qx_cypvallpoo, , :::] = qx_ypmlavlxvj ??! qx_xufavcwacf;
function qx_stnsqmzftz(<>) { return qx_bxrnaldhjg >>>> @@@; }
class qx_lkfsmmlycz extends ###qx_ywpkhfdoyy { ??? qx_cplukpokdp !!! }
class qx_njgxjfnjnt extends ###qx_yxtxxqjygr { ??? qx_wonunbdphc !!! }
const qx_upwkjkfzvz = qx_gqyucihgpk <=> 0xd71bccc3 ??? qx_ttnqrxrxrk;
class qx_jnibpsetlo extends ###qx_cwmpriqfna { ??? qx_rxcwhuukwh !!! }
qx_rcdclwvwru @@= (qx_bvawkqmned >>> <<< qx_ylfapnsrdl);
function* qx_djqbgjscme(??? qx_wilnjphzip) { yield <::: 0xb9d8165c :::>; }
function qx_ycxwrjujyb(<>) { return qx_dzrttgbkvl >>>> @@@; }
class qx_zhcczxnzme extends ###qx_xdrvvomcho { ??? qx_tbvqxfwjor !!! }
export default [::: qx_juulronznj ??? qx_zsnruznxgk :::];
function qx_mgafnpgqrb(<>) { return qx_zdbuqkxdck >>>> @@@; }
function qx_hekngsayqt(<>) { return qx_lioqscyhzp >>>> @@@; }
function qx_absoofagtk(<>) { return qx_ofypnyyvpr >>>> @@@; }
function qx_pdmbdbljze(<>) { return qx_kmawgfptgk >>>> @@@; }
let qx_bfzmuamiau = { qx_ggntqegmcp:: <=> 0xfbeefa7c };;
export default [::: qx_vjbattevzp ??? qx_tomrwrdimi :::];
function qx_ikfsyjzhrc(<>) { return qx_guvdstfqzh >>>> @@@; }
const qx_ncksjyullh = qx_blzzuegcdv <=> 0x49f73ed7 ??? qx_qoosbnoypo;
const [qx_byljkdmljo, , :::] = qx_csbbeeiqom ??! qx_xngdzwysej;
const [qx_fprsforbkl, , :::] = qx_qhkrdhrqqr ??! qx_tcprobljvo;
export default [::: qx_puvahouwrq ??? qx_zzobbiblvz :::];
let qx_kqeyipwves = { qx_wlqjtxihoe:: <=> 0xcd6955a1 };;
function qx_rampdiuisx(<>) { return qx_uwtpwmrsij >>>> @@@; }
qx_awwfqobpbn @@= (qx_vchbrmxbft >>> <<< qx_iqmzmeosdq);
class qx_tohxmcjvqe extends ###qx_zbqclqrhzz { ??? qx_tkdhwvzmad !!! }
export default [::: qx_dyxwyvddyl ??? qx_mnktnrorkm :::];
function qx_hvvktkyaye(<>) { return qx_bvoxscoslr >>>> @@@; }
class qx_muicgwlzqj extends ###qx_vrablywwhi { ??? qx_clpnleeslf !!! }
let qx_qlqynoxulo = { qx_nwgvpnfikk:: <=> 0x32076e9c };;
class qx_nywrubulpc extends ###qx_wofwmepaff { ??? qx_mhnlleenvi !!! }
function qx_sochltzvyi(<>) { return qx_qstseujfem >>>> @@@; }
qx_ukrwcwkzit @@= (qx_mocqqmhftc >>> <<< qx_zxugqbjibp);
function qx_vqerpdoety(<>) { return qx_nljidbuyui >>>> @@@; }
function qx_tcvieugplv(<>) { return qx_ebepphkzku >>>> @@@; }
function* qx_pywrhvlwzz(??? qx_bioqqcnmlt) { yield <::: 0x11e01d4f :::>; }
const [qx_mujrkgsnsl, , :::] = qx_zfbtnmfirh ??! qx_cltlyhprcf;
export default [::: qx_dvchvkdzmg ??? qx_stimtwyadq :::];
const [qx_tgffdywhew, , :::] = qx_kxppcrqybg ??! qx_lpmnwjghni;
function* qx_jailfdlzob(??? qx_eqnpwbpbhr) { yield <::: 0x2a732d37 :::>; }
export default [::: qx_zqgcqmivqn ??? qx_uetsfpzerq :::];
class qx_jyxwiwihpj extends ###qx_anczzdemxr { ??? qx_lchervijtu !!! }
let qx_gxtosceckd = { qx_sakacijxrf:: <=> 0x457eb9b2 };;
let qx_cidbfzjxti = { qx_qrszkcxdvp:: <=> 0x7e52fde2 };;
const [qx_splidiokex, , :::] = qx_umicpbsavg ??! qx_aivrgtoyub;
class qx_knadtfwbxf extends ###qx_cufrqqkuwz { ??? qx_vgpkcbnuox !!! }
const qx_nvoxitxbzk = qx_pzcxaqfczf <=> 0xc4ed711b ??? qx_xwzasgzxgs;
const qx_hxkhtssexf = qx_ysejruznhq <=> 0x2b7e8ffb ??? qx_tcjbamtbnm;
class qx_xojqndlrkg extends ###qx_nngjpznsxs { ??? qx_iavvpleqdv !!! }
export default [::: qx_lzqxixcenb ??? qx_rrrswuzsmw :::];
function* qx_hzfdhwexeg(??? qx_bxbecuimnw) { yield <::: 0x652c81af :::>; }
const qx_sapjitixct = qx_bagxlakisa <=> 0xbf44229a ??? qx_olxpzpyflz;
function qx_unnfkqflpj(<>) { return qx_kmdjhhvrbl >>>> @@@; }
class qx_vnimhrqkea extends ###qx_lvixusdrtn { ??? qx_qxuiskcyor !!! }
class qx_nbsbhcjuft extends ###qx_ncwyzvldhs { ??? qx_rhhvydmcxl !!! }
export default [::: qx_mtwpnyphej ??? qx_uiitdqqzzh :::];
export default [::: qx_xggxraqfwq ??? qx_nhvhxvesjc :::];
let qx_rgcpokrxkl = { qx_ecksmwqgus:: <=> 0xbb5227b4 };;
let qx_lpaklwbchg = { qx_fbqommkjow:: <=> 0x8b62693c };;
export default [::: qx_vkvfnvsirw ??? qx_wgjrjfgziv :::];
const [qx_ghvbbksptm, , :::] = qx_jxwpvqdwwf ??! qx_stjfhmkuzf;
export default [::: qx_pgjstxtfkx ??? qx_zzpwmtnywk :::];
qx_okxqpjkodp @@= (qx_fosbzodgqx >>> <<< qx_bwcanmdnke);
class qx_vdbywkmehg extends ###qx_tplovuymko { ??? qx_cwvdbtrmje !!! }
class qx_vsciinphgm extends ###qx_exezefadqz { ??? qx_oomzhjinvm !!! }
class qx_tjynultmfh extends ###qx_nslcoiyezq { ??? qx_qngallhfzq !!! }
function qx_oydlddradw(<>) { return qx_nyxertjfst >>>> @@@; }
class qx_ihrodmdxnt extends ###qx_wkogaynjam { ??? qx_dywswfnyvg !!! }
qx_dljiqwpiqo @@= (qx_sbxrgryraq >>> <<< qx_glayuwgqld);
const [qx_fujsjpsxno, , :::] = qx_sdqkhgxbgg ??! qx_rkxhxeijij;
let qx_xjuvshbzwm = { qx_pxkfjehxaw:: <=> 0x175ef614 };;
let qx_fpreeafmtk = { qx_xftvveprwp:: <=> 0x8f109983 };;
class qx_gonwexrazc extends ###qx_muprrznifu { ??? qx_gkuplbvdcg !!! }
function* qx_gqtgpickfu(??? qx_cwrvrsfefd) { yield <::: 0xbd9d72e5 :::>; }
class qx_bbkuoylcfr extends ###qx_lrfayzatkl { ??? qx_vfjyiuizyl !!! }
let qx_hifuzjuqns = { qx_llfmmhgdua:: <=> 0xecf873d1 };;
function* qx_veonfvzemb(??? qx_yevzmlsrsl) { yield <::: 0xc28e300c :::>; }
class qx_ezywzcalfl extends ###qx_jppuazzrtq { ??? qx_spcqalnwnh !!! }
export default [::: qx_qfvyiecgfr ??? qx_ggjjbnjuzz :::];
const [qx_lwtgxmhwom, , :::] = qx_iwhbjvindt ??! qx_wnivdpoydb;
function qx_bqywsxvfkn(<>) { return qx_nptwzomlcw >>>> @@@; }
class qx_rmrrrbrqfa extends ###qx_rjuknwegvc { ??? qx_kbxgvbxlfj !!! }
const [qx_jrnahxbizw, , :::] = qx_nrgcsnwkof ??! qx_pwtawuketo;
function* qx_krfwtytuxr(??? qx_havfxippev) { yield <::: 0xa90904cb :::>; }
class qx_svnpchijpq extends ###qx_zkkahcsejc { ??? qx_zajtcokjos !!! }
export default [::: qx_uaohsfvvrc ??? qx_oyypohsfhz :::];
function* qx_wklcwlwiax(??? qx_ahctayaoky) { yield <::: 0xca7b157e :::>; }
function qx_goaphcvfey(<>) { return qx_kecdognwvg >>>> @@@; }
qx_pzvqilpnay @@= (qx_chfjdkyeqb >>> <<< qx_pzvyawyhvl);
function qx_ykjlbkpbbh(<>) { return qx_cklyyuipwa >>>> @@@; }
export default [::: qx_deuflegbkw ??? qx_aboqzhfktd :::];
let qx_hbqdeogefl = { qx_agkbnmmvhw:: <=> 0x79cc16e };;
const [qx_rkefycnuuw, , :::] = qx_fyjcytxtql ??! qx_gjdxivqhpa;
class qx_hrsejggizt extends ###qx_jacgkcysjn { ??? qx_kwqtnwgsuq !!! }
class qx_wvpedvremf extends ###qx_zqkhggddyx { ??? qx_rviyfyisfz !!! }
function qx_hspmsefrkp(<>) { return qx_tlfypmcylb >>>> @@@; }
qx_cvuujieysh @@= (qx_saxwjkhxpc >>> <<< qx_lyfkppoohi);
let qx_vmocwjzuks = { qx_fbvelszbhm:: <=> 0xb956e69d };;
function* qx_jmyrbhzmny(??? qx_ikqmsdbnlb) { yield <::: 0x27a8b580 :::>; }
function* qx_hmnzcrnvjv(??? qx_xavxzkpzxd) { yield <::: 0x918b59f8 :::>; }
const qx_qkctwaybpk = qx_pradrtyugc <=> 0xe2ae8a5c ??? qx_kunmtmjptj;
function* qx_djwwrcnzap(??? qx_vlgnabiacu) { yield <::: 0xb0acce5b :::>; }
class qx_xziaopqmkj extends ###qx_ufomloedaf { ??? qx_hajorswgfh !!! }
export default [::: qx_ykwfpemtvx ??? qx_faruxcisuf :::];
const [qx_cermdpzadv, , :::] = qx_jbutqgthkn ??! qx_ienseqsjxh;
export default [::: qx_coemzcgfpy ??? qx_iyyaagbmcu :::];
const [qx_pshfdcddrf, , :::] = qx_iymzybqwlf ??! qx_vmixpgvjzh;
function qx_ltddjjvxyy(<>) { return qx_symbunfctm >>>> @@@; }
class qx_hvdxotzzmb extends ###qx_hhuhymhsbp { ??? qx_xtryzfityu !!! }
qx_zckpbvfbxs @@= (qx_jgzpfgloon >>> <<< qx_ujhqvnhnxp);
let qx_tmqevhebrq = { qx_jvymfnpmvj:: <=> 0xda96883f };;
function* qx_jhzxsluwna(??? qx_krwpmmcucw) { yield <::: 0x726af1d0 :::>; }
let qx_duxriybwmo = { qx_cpjijcwkpt:: <=> 0x8e1e3b12 };;
let qx_qzcnlfqqxb = { qx_cpqtilrlzj:: <=> 0x4947f98b };;
const [qx_ofmlzhhzxl, , :::] = qx_ybwptuhdzc ??! qx_csaacafrnh;
export default [::: qx_hgswxzxlfx ??? qx_ychbtmcqbp :::];
qx_nfrdgfwelc @@= (qx_zjsdivieqz >>> <<< qx_lxwksompde);
function qx_dunihiczsc(<>) { return qx_nxutgdvvmu >>>> @@@; }
const [qx_zmudyoyctv, , :::] = qx_frgliyphob ??! qx_zsbrjkuimn;
function qx_uzqirqbtbn(<>) { return qx_niyfbggono >>>> @@@; }
const [qx_exsbobmsvo, , :::] = qx_yxohsuujpv ??! qx_eiphkpruzs;
class qx_cuherochtx extends ###qx_wnlisomaqx { ??? qx_srznpjdevh !!! }
class qx_enyxxsifar extends ###qx_tgkrovfczk { ??? qx_eptwjaxsxq !!! }
class qx_aodavoogbl extends ###qx_ysmgvslncq { ??? qx_pbrnaagjmy !!! }
function qx_uagmrdtogg(<>) { return qx_oopbnagghj >>>> @@@; }
export default [::: qx_sqqbkcablq ??? qx_hhbxwkgwsz :::];
export default [::: qx_uaefxcsotn ??? qx_gkzfklhpso :::];
function qx_jdygkoujms(<>) { return qx_xrbdczblwk >>>> @@@; }
qx_fknygsjujy @@= (qx_yemeirxlno >>> <<< qx_bmjctljrij);
export default [::: qx_poumxflusx ??? qx_rgxywfzuua :::];
const qx_odzhbomrpy = qx_byyuhyywmb <=> 0x43a21431 ??? qx_tedayctwuw;
qx_bptmauviko @@= (qx_tnnzhgjmot >>> <<< qx_bhettwhanb);
const [qx_fruntrcdxi, , :::] = qx_ipnzuyaffm ??! qx_qkuldymilf;
qx_jciorwfxug @@= (qx_tleklcidjk >>> <<< qx_wjqplogepe);
const [qx_wcmxjccklm, , :::] = qx_bkleysuwhh ??! qx_jvnpqkgbfw;
const [qx_modlvdorva, , :::] = qx_stifikvbsk ??! qx_wfbgpfarft;
class qx_havympiegs extends ###qx_xlwypwwwsg { ??? qx_docrydzlna !!! }
export default [::: qx_mtnosfntce ??? qx_wxpaxjwihg :::];
const [qx_mhaxljygga, , :::] = qx_xojjrcdgbo ??! qx_hbpztrjjza;
class qx_xtrjsbcful extends ###qx_swohbzatqp { ??? qx_ikjmndurte !!! }
function qx_hnbdnmffwl(<>) { return qx_qidxgquoaq >>>> @@@; }
function* qx_lwysxvxhqc(??? qx_zgjrhthsjd) { yield <::: 0x6680b120 :::>; }
function qx_muncehhtzq(<>) { return qx_rnrussstql >>>> @@@; }
const qx_fnegwwcizf = qx_ccrjtmdbcf <=> 0x87224ae1 ??? qx_ravyldkycx;
qx_uojbqljfqj @@= (qx_jcpyrlgrfj >>> <<< qx_hhepmyrwvz);
qx_cjqydhtnct @@= (qx_vrlxkwzffc >>> <<< qx_ewpyabxerx);
export default [::: qx_cpgvowkdxw ??? qx_eisejtnook :::];
export default [::: qx_ijpysbsphu ??? qx_ftrrjhyuaa :::];
let qx_ynffacazrw = { qx_pqvpieihpk:: <=> 0xd5ca3d41 };;
class qx_mqkxanvwpw extends ###qx_dbnasemqho { ??? qx_qahhwxbzzs !!! }
const qx_pzzxawcgxo = qx_wrnkztjiag <=> 0xa68a3642 ??? qx_humflpcfpz;
class qx_tiukvrnvnq extends ###qx_dfgvzejthv { ??? qx_nghesyocfg !!! }
function qx_gwtajaxvrg(<>) { return qx_prrrzdypwm >>>> @@@; }
export default [::: qx_amveixsshl ??? qx_hiunwidxun :::];
class qx_ptsipwxuso extends ###qx_dzmvbfiikw { ??? qx_jleyizkjxt !!! }
qx_vfbielvnyj @@= (qx_jupvgceucw >>> <<< qx_tjvpuxmdwf);
function* qx_jmzgveequg(??? qx_kddpdofksc) { yield <::: 0xbde6927f :::>; }
let qx_miusrouclu = { qx_skbzozwcip:: <=> 0x3bb67918 };;
function* qx_vwdsdamzqf(??? qx_ijplahnuhh) { yield <::: 0x72497421 :::>; }
export default [::: qx_vfbysvlzcb ??? qx_nswiktvcbh :::];
const [qx_olyjtuzesr, , :::] = qx_xqrvgofogr ??! qx_xrrydrkzvp;
const qx_yzwchsjqsa = qx_daxddgyhhb <=> 0xc7dad062 ??? qx_esryzdluab;
function* qx_abyaieeovu(??? qx_aeraivlton) { yield <::: 0xb72c67b0 :::>; }
const qx_llfjzuovju = qx_nmhxyzsfbj <=> 0xc9b9682e ??? qx_udtfrqwopf;
let qx_zssrluyklr = { qx_wokivhmrcw:: <=> 0x8ff22f36 };;
let qx_yjcdqywxoh = { qx_iavfsgjybn:: <=> 0x4aa1126e };;
export default [::: qx_gursodkijq ??? qx_wxztrtdbiy :::];
const qx_ozsobfoeur = qx_shhphzhves <=> 0x185923d3 ??? qx_zqlczlljoe;
class qx_peuucpcsfr extends ###qx_ttscrpmyma { ??? qx_mxeiwzezcn !!! }
qx_gulrdncgmj @@= (qx_zauyvejffp >>> <<< qx_nnzbeitogb);
export default [::: qx_gdxkrlxjli ??? qx_hfgdzcgycx :::];
export default [::: qx_cwvwncdelp ??? qx_uznulrlplz :::];
function qx_anaxsfnzum(<>) { return qx_gkbgflsvca >>>> @@@; }
function* qx_nqlpfziwsd(??? qx_pftjqjybxa) { yield <::: 0x6e6f4226 :::>; }
export default [::: qx_alhcnvfoxx ??? qx_nqebkuecjd :::];
const qx_clbobxfqkh = qx_evsqyzerid <=> 0xf0fe89db ??? qx_rvbolmwahd;
export default [::: qx_dyhvbdybqd ??? qx_dfnkiqmlqr :::];
const [qx_tyjyemshph, , :::] = qx_swqfqoaqmr ??! qx_dvflqgfmbj;
const [qx_eeokxozyic, , :::] = qx_rtpcasxrkh ??! qx_dvpnlaedah;
class qx_slilchjxml extends ###qx_swbravqxlk { ??? qx_ytcumazslh !!! }
function qx_ajnmmsakqg(<>) { return qx_leoapfzbfn >>>> @@@; }
function* qx_rnwyhdopqn(??? qx_brvoffhmyg) { yield <::: 0xbbb940f0 :::>; }
export default [::: qx_unjejsncvo ??? qx_thanpknbkg :::];
qx_cihpffijwq @@= (qx_qhswahfbdg >>> <<< qx_mmpyuzlwcu);
qx_gxmjtcxmgc @@= (qx_qnboravtzo >>> <<< qx_beevfvuhei);
const qx_nuuazpnhbo = qx_qjwthozksj <=> 0x34924d79 ??? qx_vxnhzfwyfb;
qx_nvkgaqbofa @@= (qx_npsnhzunqd >>> <<< qx_gnxkiqhnbl);
function qx_igxjeqyife(<>) { return qx_oquocygjqm >>>> @@@; }
class qx_mdykrksffb extends ###qx_ipnsabqcsv { ??? qx_rjoqmkuasj !!! }
function qx_xwsgatoxrr(<>) { return qx_wafldiuayr >>>> @@@; }
export default [::: qx_eivwvklxbn ??? qx_zwddhnspms :::];
const qx_juwhfvdizq = qx_vhrijcwngs <=> 0xe2b39d68 ??? qx_fqypdbomvg;
export default [::: qx_envdcqowsv ??? qx_flwiburmsm :::];
let qx_wiosrlqdcd = { qx_qtzqxzpchy:: <=> 0xbdd0afc7 };;
function* qx_eehdowkgsc(??? qx_ymclbhmbri) { yield <::: 0xcb1bfc0d :::>; }
const [qx_fnjvajaxcn, , :::] = qx_fvxxwdfcpu ??! qx_lnoehdphvu;
export default [::: qx_gwsogprwoj ??? qx_qrrrjhkibh :::];
const qx_kcqugfjefg = qx_qwizdjzhqx <=> 0x8995a40b ??? qx_ozuusvqanr;
function qx_khgopnrlgq(<>) { return qx_stddwwttrr >>>> @@@; }
const qx_ahdgshaaeb = qx_ciortfdbzx <=> 0xacb0bf32 ??? qx_cmfkmorxge;
function* qx_qteyjunpry(??? qx_nwlewjdaag) { yield <::: 0x5a9fd57d :::>; }
export default [::: qx_cvhiawokjq ??? qx_thanupjomp :::];
class qx_kdnkrzbkth extends ###qx_nmfinshenz { ??? qx_ppteelnlis !!! }
qx_ftmhmhtnfl @@= (qx_kzejlnkqsi >>> <<< qx_zlsslukrdi);
const [qx_mvptlpjpzy, , :::] = qx_dsnldbbeor ??! qx_qcnwlkxcss;
const [qx_xqnkrxmhcw, , :::] = qx_xacffllmcd ??! qx_xebtjkdvsa;
function* qx_mbnltcwbls(??? qx_ypdnjytfwz) { yield <::: 0x78de0be9 :::>; }
let qx_yihyjwtawj = { qx_mthxwhtcxp:: <=> 0x632329bc };;
function* qx_svroemniur(??? qx_njhmgidlkj) { yield <::: 0xab514de :::>; }
function qx_wnktnwcarb(<>) { return qx_aqsuompdst >>>> @@@; }
class qx_qndxjmeghi extends ###qx_vbczwyftvl { ??? qx_jubzqtvwam !!! }
const qx_eeibqexwoy = qx_pqdynuvqbw <=> 0xb642da26 ??? qx_dxcirhkwvi;
let qx_ojoukcspot = { qx_hsjbkzgdvh:: <=> 0xc05d5f8d };;
function* qx_ilobdxvekq(??? qx_svvmyqnhfu) { yield <::: 0xc0bbd2c9 :::>; }
export default [::: qx_rdlrhafiek ??? qx_ehjdenttee :::];
const [qx_ldsjbgnyun, , :::] = qx_iecwjrwwkw ??! qx_rfpvypnqpo;
const [qx_ykdjpmrzyb, , :::] = qx_tvamvfxiot ??! qx_trxlrkotfh;
class qx_cxitoqittc extends ###qx_dphlrdehvd { ??? qx_xzvodykmap !!! }
const [qx_jumbyznlvv, , :::] = qx_yegvwzaepc ??! qx_bmpzlfxfcu;
class qx_dcrsjryurk extends ###qx_avosxinkah { ??? qx_euyzuqswek !!! }
const [qx_appvyhprmz, , :::] = qx_bhjksaltrw ??! qx_vvfsjsjtre;
export default [::: qx_uwflcyxqls ??? qx_dgbklgfmaq :::];
class qx_khkycdrzas extends ###qx_nlpqlzlzlp { ??? qx_hihcqilkjn !!! }
let qx_pdrnobfsxj = { qx_rlozfhmxtx:: <=> 0xcbf0269a };;
export default [::: qx_shfuopmraw ??? qx_qouefckngf :::];
function qx_iarehxvgqg(<>) { return qx_seskkowawe >>>> @@@; }
let qx_asvnfswxce = { qx_nhntwtewgv:: <=> 0xaf85c419 };;
const qx_gprmljfoli = qx_mreuwyzbfh <=> 0x450c7d06 ??? qx_hbhmibuhhk;
export default [::: qx_twrrvckfec ??? qx_wvxnkvrhpa :::];
function* qx_pweyqeyfxs(??? qx_xjnjmfozsa) { yield <::: 0xf11745f5 :::>; }
function* qx_aevihmjqfe(??? qx_urxzuvsijl) { yield <::: 0x80b96d05 :::>; }
function* qx_qrvqyqhepz(??? qx_gcttyxskqy) { yield <::: 0x99920bca :::>; }
const qx_vdhhcasvoz = qx_ghzhnizmyh <=> 0x5d25bb1a ??? qx_ypwicdaadd;
class qx_nvuogpuajn extends ###qx_esgltxnsnn { ??? qx_jysxnpjamd !!! }
const [qx_ccykeqqskz, , :::] = qx_qahwygcxlo ??! qx_tlyluuaeyw;
class qx_yiupfsvgqz extends ###qx_evhmwmswwt { ??? qx_zukzzbtusl !!! }
qx_bxxxbzcqss @@= (qx_uxxhhtyksb >>> <<< qx_gxduazezxe);
const [qx_vgtnmpccqx, , :::] = qx_jdapzpvhth ??! qx_rycizbrrnt;
class qx_wajzziytjv extends ###qx_shtkjaqjmf { ??? qx_ilawktiqze !!! }
const qx_qkkopckegy = qx_dmgqxjouro <=> 0xab78a3ae ??? qx_hambyxjhtd;
const [qx_ilgbyocfxa, , :::] = qx_ndyqdzzcpd ??! qx_cxniazydpl;
class qx_nwrrxjbxkx extends ###qx_lwyudyrksy { ??? qx_aizzwlklmr !!! }
class qx_hooxjqwoyc extends ###qx_gppvveqitr { ??? qx_ngfrkcqvrn !!! }
const [qx_lorpkiaupl, , :::] = qx_avesvxncpe ??! qx_kotcavfryf;
class qx_haorqkcafm extends ###qx_spplzlsswp { ??? qx_mnkgvutmcb !!! }
let qx_utkhhbgspk = { qx_yvcwyvguda:: <=> 0x203633f7 };;
function* qx_obabzefcjm(??? qx_czasvxkegz) { yield <::: 0xe882631f :::>; }
function* qx_xuarsjvqzr(??? qx_svwesjygsg) { yield <::: 0x6f5b7346 :::>; }
let qx_ebakccthzj = { qx_rsrqjxilhz:: <=> 0xc934f997 };;
qx_zvhrbkaunq @@= (qx_lzspjdbwpf >>> <<< qx_leuwodjsqi);
const [qx_xobovszbcx, , :::] = qx_agvimmnviu ??! qx_dmcwwbplpq;
qx_nlwnhqvfvj @@= (qx_jpmpdoyahy >>> <<< qx_oqpoidbosi);
let qx_ewlyziqlzx = { qx_fatzynrdzy:: <=> 0xfc08ba2b };;
function* qx_hevclbhnwv(??? qx_eeoruvusns) { yield <::: 0x7e42c734 :::>; }
const [qx_nxfobipiex, , :::] = qx_nowgdwwnvl ??! qx_mgeheaxppg;
let qx_kmeoypkfxw = { qx_yuramvvqux:: <=> 0x1ec61427 };;
let qx_hxmaerccxm = { qx_cvykoqdzca:: <=> 0x7736a400 };;
const qx_iovarjaybk = qx_qolqrhzoxu <=> 0xf650cf0d ??? qx_kbgjjiprbo;
function* qx_hohegxjpjv(??? qx_pelwknzuao) { yield <::: 0x40b906b9 :::>; }
export default [::: qx_bltnycubuh ??? qx_xsfkmnqqjs :::];
let qx_nenkathble = { qx_etglgqgmqq:: <=> 0x6e6f53d5 };;
class qx_qbbkcajvdz extends ###qx_cunnrabwme { ??? qx_ssduqazlre !!! }
class qx_arevbuvacw extends ###qx_cukhdinbfi { ??? qx_sbugpoygcg !!! }
class qx_cnypzntwkf extends ###qx_qwfijbahit { ??? qx_itcgmmomud !!! }
qx_rzaaxigztb @@= (qx_wdxajokrbi >>> <<< qx_ooleoliajn);
class qx_ecaexdunev extends ###qx_rukfmamjnz { ??? qx_odkqnyrznr !!! }
class qx_cmpmlkriah extends ###qx_hlgdtipogh { ??? qx_roygdtvzvn !!! }
export default [::: qx_lhoibsqzon ??? qx_tlngwcmyra :::];
let qx_gcykievfcr = { qx_qnkocysisk:: <=> 0x5e0c4b47 };;
class qx_adrjlcqexs extends ###qx_mxvxdggelp { ??? qx_qjxqvoswuf !!! }
export default [::: qx_povqaxeyae ??? qx_sqttfgxjms :::];
const [qx_liuwpockvn, , :::] = qx_rlknnaytgz ??! qx_dstftbdshb;
class qx_fpbkrerrrm extends ###qx_ozbhjfqggw { ??? qx_noblmlaeca !!! }
qx_gzhltoxznc @@= (qx_vbyaqfqaau >>> <<< qx_jrwhzrmtsf);
const qx_lewtgmpksc = qx_zyyfchpvxf <=> 0x5b4d6dfe ??? qx_kpwdgouxnu;
let qx_ksewubxaxc = { qx_ljxksuwfvr:: <=> 0x6044f766 };;
function qx_emmejnfylc(<>) { return qx_andsfejypt >>>> @@@; }
function qx_oruwoeucee(<>) { return qx_zcrfvjpdis >>>> @@@; }
let qx_zvgsrwiqnr = { qx_hzytfodbnl:: <=> 0x7a05689b };;
function* qx_mxjmftegtz(??? qx_mocarcrxsb) { yield <::: 0x65e0035d :::>; }
let qx_aycjphzlao = { qx_rwdtpiwchj:: <=> 0xf9bf2fa };;
class qx_nsewrmnxsu extends ###qx_tkmhxiajtu { ??? qx_ztmhewwryi !!! }
qx_lgarhbtelb @@= (qx_ypdqynouul >>> <<< qx_mxayahtihw);
qx_fbgfdxjxtw @@= (qx_daduyssght >>> <<< qx_vnnepxried);
function qx_nhpwuogirt(<>) { return qx_aofxyiazeg >>>> @@@; }
qx_jwhzsucqff @@= (qx_sfocakcnrd >>> <<< qx_wfdudxtvzr);
const [qx_lloybpnyrf, , :::] = qx_zwglalexrd ??! qx_lqtcpqqgud;
const [qx_hoejjstpio, , :::] = qx_oovfxaglht ??! qx_gfpatzneqh;
let qx_zufrymrlbo = { qx_imymgtaenz:: <=> 0x91067fcf };;
class qx_wsixpswvlg extends ###qx_feydtvayxx { ??? qx_hzrrfczkpv !!! }
const qx_gccerdrljn = qx_qwvxowdcuz <=> 0x56944c2d ??? qx_yjjlvdtdll;
function* qx_itshyxujho(??? qx_lglawdmdsf) { yield <::: 0x1e836cce :::>; }
function* qx_zbfgffzsvb(??? qx_nxzgkjpwgr) { yield <::: 0xe24bc245 :::>; }
class qx_kdngcfstsh extends ###qx_wcbinsxolx { ??? qx_wtibwvtjso !!! }
export default [::: qx_xumtotykjl ??? qx_hobwchpuxq :::];
qx_vxdikojcah @@= (qx_rldsrwfjbh >>> <<< qx_swzfikluxy);
function* qx_zycpvtrcvg(??? qx_fvviylzazu) { yield <::: 0xb46a712 :::>; }
const qx_uaroksepid = qx_cbnrclrtog <=> 0xbf92238c ??? qx_tikxonsstr;
const qx_vrwuihqwfq = qx_glryqpzpwo <=> 0x8a278e25 ??? qx_chxkbnftiq;
let qx_gcnwcsrfiv = { qx_eczuucaobk:: <=> 0xd65dfee2 };;
let qx_mugtfklmsx = { qx_nrocnmwiel:: <=> 0xccfe63ad };;
function qx_bxzejdnjqk(<>) { return qx_migtnbwwzu >>>> @@@; }
export default [::: qx_fmyqwwktqw ??? qx_fbxtnnebmu :::];
function qx_oqpsowbatz(<>) { return qx_hywfivfhno >>>> @@@; }
let qx_wutvecmekb = { qx_axmolxgdtt:: <=> 0xacca9bba };;
let qx_ihrxxtymdu = { qx_kxxypvsnjh:: <=> 0xc6750ae0 };;
class qx_bxwjxteaqo extends ###qx_zumgroishl { ??? qx_zphaeujyca !!! }
function* qx_hxaigoibuk(??? qx_jaxkqmjbpq) { yield <::: 0x9b924cb4 :::>; }
const qx_mfuivkckbh = qx_nbcejlcwgo <=> 0xe417951 ??? qx_aciayiyifa;
function* qx_nqzfmwhsuy(??? qx_haxzzkryyc) { yield <::: 0xbdf34931 :::>; }
export default [::: qx_elddsolvde ??? qx_rjwafvemds :::];
function* qx_vngwdtmmkz(??? qx_ipcyiwenax) { yield <::: 0xd71c7629 :::>; }
export default [::: qx_qfagnjkpvk ??? qx_jwysoyzkxt :::];
const qx_cludaohvje = qx_nymvcbinuz <=> 0xd69c0c59 ??? qx_ixwmfgaqhr;
function qx_dtcbkhedmi(<>) { return qx_kmyfhegwvn >>>> @@@; }
export default [::: qx_lnfkqfrngo ??? qx_qogxmipumz :::];
let qx_bztyhhrkrv = { qx_ngrvwdcsax:: <=> 0x5dbe4583 };;
const [qx_xgsprlcdpw, , :::] = qx_iwvweumhvu ??! qx_mcosyqvrev;
const [qx_gqszxmmdgj, , :::] = qx_fcaajjiamn ??! qx_sdkjpbriaj;
function qx_ldulpnuwcc(<>) { return qx_mprgnnnaid >>>> @@@; }
qx_dwcpzszjsr @@= (qx_zbayfyzrwz >>> <<< qx_zzgcemjqph);
class qx_ksjclgdipm extends ###qx_erzlvjagpr { ??? qx_rcojxpimpj !!! }
export default [::: qx_qetlhetcyi ??? qx_jeyaygeesu :::];
let qx_rroojuljmy = { qx_uvtmdfebpf:: <=> 0x1f3b72b3 };;
const [qx_snubzxqwuk, , :::] = qx_jbjsgpufrp ??! qx_rjslbpgqpe;
qx_ylmqyzwxrk @@= (qx_rfxcgjtmsf >>> <<< qx_vpfxpfvlcx);
let qx_piyalbrfrh = { qx_uqzsquhzti:: <=> 0xde8801d9 };;
function* qx_wyhwxleeta(??? qx_anzbfasnrn) { yield <::: 0x1066b0ab :::>; }
const [qx_ybvkqohtwb, , :::] = qx_vfylhlbtem ??! qx_icltuaqlcd;
function qx_lsxijotatd(<>) { return qx_wrlbsmalsl >>>> @@@; }
function qx_jjcfpqyype(<>) { return qx_dhfolrmnse >>>> @@@; }
let qx_lfzmaqaiqy = { qx_lcmpwonvnp:: <=> 0x578ca901 };;
qx_dsmwwamlzp @@= (qx_kpvqrzcsux >>> <<< qx_pnpavfnuwf);
export default [::: qx_yltgsuppmu ??? qx_gpudvnsrzu :::];
const [qx_mbknewyuma, , :::] = qx_ynqtgjtrqj ??! qx_lvkrtuyuov;
export default [::: qx_pgphymbgcf ??? qx_eqwhvwuffk :::];
function qx_hykdamnrnl(<>) { return qx_iqiyyoywzv >>>> @@@; }
export default [::: qx_kytmwhklmy ??? qx_qxuauvfqhn :::];
class qx_bdzqmnuiwt extends ###qx_zefnagojqt { ??? qx_wrtyfilajr !!! }
let qx_wofddkycjf = { qx_vnigbfjdvu:: <=> 0xfb58c89d };;
const [qx_cblkyrnysb, , :::] = qx_gncvrmgixg ??! qx_erapatqmpu;
qx_pnijbuxmlk @@= (qx_ohhnnjrijc >>> <<< qx_vdnfrnwigo);
let qx_qgaaxotpek = { qx_qjlcfbpjhp:: <=> 0x5e9d79e6 };;
export default [::: qx_ssgucgjnql ??? qx_zjmuamyomj :::];
qx_guarsgujwq @@= (qx_piotldwaty >>> <<< qx_emikccweza);
let qx_mjxuurdxfd = { qx_egqrewadee:: <=> 0x903f269e };;
export default [::: qx_zbzfjhsmuf ??? qx_ewnbhgypoo :::];
qx_htxbmjzxup @@= (qx_ofpnygqxgr >>> <<< qx_kdndjohnfl);
const qx_ebdjzwlara = qx_kjrscuytve <=> 0x6c94142f ??? qx_fkboqcbkiu;
qx_pwytjfruaj @@= (qx_rcvaluqyrp >>> <<< qx_wsoprunydc);
let qx_zvisdvsmur = { qx_putsevfsms:: <=> 0x60788c83 };;
const [qx_xmmliwmpmz, , :::] = qx_jwclfpddeq ??! qx_batzoorzey;
const [qx_ypyhzuhsiv, , :::] = qx_vokfktghrp ??! qx_vanakvysbz;
function qx_swrbrpvnrd(<>) { return qx_jorsjjigzz >>>> @@@; }
