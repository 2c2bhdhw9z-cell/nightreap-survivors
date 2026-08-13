/**
 * The append-only event log — the storage half.
 *
 * `log.ts` holds every rule and knows nothing about a database. This file is the other half: it fetches the
 * few facts a rule needs, applies the rule, and writes the row. It is deliberately thin, because thin is
 * the only way the guarantee survives — the moment storage starts making decisions there are two places
 * that decide, and one of them is the one nobody tested.
 *
 * WHAT THIS FILE IS NOT ALLOWED TO HAVE, EVER:
 *   - an update path
 *   - a delete path
 *   - a second way to append that skips validation
 *
 * There is exactly one `append`, every row goes through it, and a bulk reversal is a loop over it rather
 * than a fast lane. A fast lane is a second door, and the second door is where the rule gets broken at 3am
 * during an incident by someone who is tired and means well.
 *
 * ONE WRITER AT A TIME. Appending is read-the-head-then-write, and two of those interleaved would produce
 * two rows claiming the same place in the chain. Every append is queued behind the last one, so the read
 * and the write are never split by another append. The unique index on the row hash is the backstop for
 * the case this cannot cover — two server processes writing at once — where the loser is refused rather
 * than silently accepted, because a fork in the chain is worse than a failed write.
 *
 * A SEQUENCE NUMBER IS ONLY EVER ALLOCATED FOR A ROW THAT IS ABOUT TO BE WRITTEN. Nothing hands out
 * numbers in advance. A gap in the numbers is a chain fault by design (see `verifyChain`), so a number
 * issued to a write that then failed would be indistinguishable from a deletion — an alarm that fires for
 * a reason nobody can rule out is an alarm people learn to ignore.
 *
 * THE BACKEND IS AN INTERFACE. The database implementation lives in `backend-db.ts` and is not imported
 * here, so every rule in this file can be tested with no connection, no credentials and no fixtures. The
 * in-memory backend below is not a mock of a database — it is a real, complete implementation of the
 * handful of reads the log actually needs, which is why a test against it means something.
 */

import {
  type AccountView,
  type BadReason,
  BAD,
  type EventDraft,
  type EventRow,
  EVENT,
  foldAccount,
  GENESIS_HASH,
  type BulkPlan,
  type ChainReport,
  planGroupReversal,
  restoreDraftFor,
  type RestoreFacts,
  seal,
  storyOf,
  type StoryStep,
  type TargetFacts,
  validate,
  validateReversal,
  validateRestore,
  verifyChain,
} from "./log";

/* ---------------------------------------------------------------------------------------------- */
/* The backend contract                                                                            */
/* ---------------------------------------------------------------------------------------------- */

/**
 * Every read and the single write the log needs. Nothing else — no counts, no aggregates, no "update the
 * balance" convenience. Anything wider would let a caller reach past the rules.
 */
export interface EventBackend {
  /** The last row in the log, or null when the log is empty. */
  head(): Promise<{ seq: number; hash: string } | null>;
  /** Write a sealed row. Returns false when the row is already present (its hash is unique). */
  insert(row: EventRow): Promise<boolean>;
  /** One row by its sequence number. */
  byId(seq: number): Promise<EventRow | null>;
  /** Rows with `fromSeq <= seq <= toSeq`, ascending. */
  range(fromSeq: number, toSeq: number): Promise<EventRow[]>;
  /** Every row tied to a bulk action, ascending. */
  group(groupId: string): Promise<EventRow[]>;
  /** Which of these sequence numbers already have a reversal naming them. */
  reversedAmong(seqs: readonly number[]): Promise<number[]>;
  /** Which of these sequence numbers already have a restore naming them. One reversal, at most one redo. */
  restoredAmong(seqs: readonly number[]): Promise<number[]>;
  /** Every row about one account, ascending. */
  bySubject(subjectId: string): Promise<EventRow[]>;
}

/* ---------------------------------------------------------------------------------------------- */
/* Append outcomes                                                                                 */
/* ---------------------------------------------------------------------------------------------- */

export const APPEND = {
  OK: 0,
  /** A rule said no. `reason` says which. Nothing was written. */
  REFUSED: 1,
  /** The row was already in the log, byte for byte. Nothing was written, and nothing is wrong. */
  DUPLICATE: 2,
} as const;

export type AppendStatus = (typeof APPEND)[keyof typeof APPEND];

export interface AppendResult {
  status: AppendStatus;
  reason: BadReason;
  row: EventRow | null;
}

/* ---------------------------------------------------------------------------------------------- */
/* The log                                                                                         */
/* ---------------------------------------------------------------------------------------------- */

export class EventLog {
  private readonly backend: EventBackend;
  /** The tail of the append queue. Every append chains onto this, so appends never interleave. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(backend: EventBackend) {
    this.backend = backend;
  }

  /**
   * Append one row.
   *
   * The order here is the whole point: check the draft against the rules that need no context, then — only
   * for a reversal — fetch the target and check the rules that do, then seal and write. A row that fails
   * any check leaves no trace, because a log of attempted-and-rejected writes is a different thing with a
   * different purpose, and mixing the two makes both unreadable.
   */
  append(draft: EventDraft): Promise<AppendResult> {
    return this.serialize(async () => {
      const head = await this.backend.head();
      const nextSeq = (head?.seq ?? 0) + 1;
      const prevHash = head?.hash ?? GENESIS_HASH;

      let reason: BadReason;
      if (draft.kind === EVENT.REVERSAL) {
        reason = validateReversal(draft, nextSeq, await this.targetFacts(draft.reverses));
      } else if (draft.restores !== 0) {
        reason = validateRestore(draft, nextSeq, await this.restoreFacts(draft.restores));
      } else {
        reason = validate(draft);
      }
      if (reason !== BAD.NONE) return { status: APPEND.REFUSED, reason, row: null };

      const row = seal(draft, nextSeq, prevHash);
      const written = await this.backend.insert(row);
      if (!written) return { status: APPEND.DUPLICATE, reason: BAD.NONE, row };
      return { status: APPEND.OK, reason: BAD.NONE, row };
    });
  }

  /**
   * The facts a reversal's target has to supply, gathered rather than guessed.
   *
   * A missing target reports `exists: false` and lets `validateReversal` decide what that means, instead of
   * deciding here. One rule, one place.
   */
  private async targetFacts(seq: number): Promise<TargetFacts> {
    if (seq <= 0) return { exists: false, seq: 0, kind: 0, subjectId: "", alreadyReversed: false };
    const target = await this.backend.byId(seq);
    if (target === null) return { exists: false, seq: 0, kind: 0, subjectId: "", alreadyReversed: false };
    const reversed = await this.backend.reversedAmong([seq]);
    return {
      exists: true,
      seq: target.seq,
      kind: target.kind,
      subjectId: target.subjectId,
      alreadyReversed: reversed.length > 0,
    };
  }

  /**
   * The facts a restore's target has to supply.
   *
   * Two reads, because a restore is checked against two rows: the reversal it names, and the original row
   * that reversal undid. A reversal whose own target has vanished reports as not existing rather than as a
   * half-known thing, so the rule refuses instead of accepting on partial evidence.
   */
  private async restoreFacts(seq: number): Promise<RestoreFacts> {
    const missing: RestoreFacts = {
      exists: false,
      seq: 0,
      kind: 0,
      subjectId: "",
      reversedKind: 0,
      reversedSubjectId: "",
      alreadyRestored: false,
    };
    if (seq <= 0) return missing;

    const reversal = await this.backend.byId(seq);
    if (reversal === null) return missing;
    if (reversal.kind !== EVENT.REVERSAL) {
      // Exists, but is not a reversal. Report it as it is and let the rule name the problem — this is the
      // case where the caller pointed the redo link at the wrong row, and it deserves its own refusal.
      return { ...missing, exists: true, seq: reversal.seq, kind: reversal.kind, subjectId: reversal.subjectId };
    }

    const original = await this.backend.byId(reversal.reverses);
    if (original === null) return missing;
    const restored = await this.backend.restoredAmong([seq]);
    return {
      exists: true,
      seq: reversal.seq,
      kind: reversal.kind,
      subjectId: reversal.subjectId,
      reversedKind: original.kind,
      reversedSubjectId: original.subjectId,
      alreadyRestored: restored.length > 0,
    };
  }

  /**
   * Put back what a reversal took away.
   *
   * Builds the row from the original rather than from anything the caller typed, then appends it through the
   * ordinary path so it is validated, sealed and chained like every other row. There is no shortcut here for
   * the same reason there is no bulk fast lane: a second way in is where the rule gets broken.
   */
  async restore(
    reversalSeq: number,
    actorKind: number,
    actorId: string,
    at: number,
    reason: string,
    groupId = "",
  ): Promise<AppendResult> {
    const reversal = await this.backend.byId(reversalSeq);
    if (reversal === null || reversal.kind !== EVENT.REVERSAL) {
      return { status: APPEND.REFUSED, reason: reversal === null ? BAD.NO_SUCH_TARGET : BAD.NOT_A_REVERSAL, row: null };
    }
    const original = await this.backend.byId(reversal.reverses);
    if (original === null) return { status: APPEND.REFUSED, reason: BAD.NO_SUCH_TARGET, row: null };

    return this.append(restoreDraftFor(original, reversal, actorKind, actorId, at, reason, groupId));
  }

  /**
   * The whole did / undid / redid story around one row.
   *
   * Read from the account's own rows, so the walk sees every link in the chain: a reversal and a restore both
   * carry the subject of the row they are about, which is what makes one query enough.
   */
  async story(seq: number): Promise<StoryStep[]> {
    const row = await this.backend.byId(seq);
    if (row === null) return [];
    if (row.subjectId === "") return storyOf(await this.backend.range(1, Number.MAX_SAFE_INTEGER), seq);
    return storyOf(await this.backend.bySubject(row.subjectId), seq);
  }

  /** A slice of the log, for the admin page and for verification. */
  read(fromSeq: number, toSeq: number): Promise<EventRow[]> {
    if (toSeq < fromSeq) return Promise.resolve([]);
    return this.backend.range(Math.max(1, fromSeq), toSeq);
  }

  /**
   * Verify a slice.
   *
   * The hash the slice is checked against comes from the row *before* it, not from the slice itself.
   * Checking a slice against its own first row would pass no matter what was done to the log, which is the
   * definition of a check that cannot fail — and one of those is worse than none, because it is believed.
   */
  async verify(fromSeq: number, toSeq: number): Promise<ChainReport> {
    const from = Math.max(1, fromSeq);
    const rows = await this.backend.range(from, toSeq);

    let expected = GENESIS_HASH;
    if (from > 1) {
      const before = await this.backend.byId(from - 1);
      // No predecessor where there must be one is itself the fault a gap check exists to catch. Verify it
      // as a chain starting from a hash that cannot match, so it is reported rather than skipped.
      expected = before?.hash ?? "missing-predecessor";
    }

    return verifyChain(rows, expected);
  }

  /** Rebuild one account's standing from the log alone. */
  async accountView(subjectId: string): Promise<AccountView> {
    const rows = await this.backend.bySubject(subjectId);
    // Reversals of this account's rows carry the same subject, so the fold sees them in this slice. A
    // reversal of a row about somebody else is not in it and must not be — that is their history.
    return foldAccount(rows, subjectId);
  }

  /** Plan the undo of a bulk action without writing anything. Safe to show a human before they commit. */
  async planReversal(
    groupId: string,
    actorKind: number,
    actorId: string,
    at: number,
    reason: string,
    newGroupId: string,
  ): Promise<BulkPlan> {
    const rows = await this.backend.group(groupId);
    const reversed = new Set(await this.backend.reversedAmong(rows.map((r) => r.seq)));
    return planGroupReversal(rows, groupId, reversed, actorKind, actorId, at, reason, newGroupId);
  }

  /**
   * Undo a bulk action.
   *
   * The plan is computed first and then applied one row at a time through the ordinary `append`, so every
   * reversal is validated and chained exactly like anything else. Rows the plan skipped, and rows the
   * append refuses after the fact, are both reported: an undo that touched 9,998 of 10,000 rows and said
   * so is useful, and one that claims to have touched all of them is a lie somebody will act on.
   */
  async reverseGroup(
    groupId: string,
    actorKind: number,
    actorId: string,
    at: number,
    reason: string,
    newGroupId: string,
  ): Promise<{ appended: EventRow[]; skipped: { seq: number; reason: BadReason }[] }> {
    const plan = await this.planReversal(groupId, actorKind, actorId, at, reason, newGroupId);
    const appended: EventRow[] = [];
    const skipped = [...plan.skipped];

    for (const draft of plan.drafts) {
      const result = await this.append(draft);
      if (result.status === APPEND.OK && result.row !== null) appended.push(result.row);
      else skipped.push({ seq: draft.reverses, reason: result.reason });
    }

    return { appended, skipped };
  }

  /** Queue work behind whatever is already in flight, whether that finished happily or not. */
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

/* ---------------------------------------------------------------------------------------------- */
/* In-memory backend                                                                               */
/* ---------------------------------------------------------------------------------------------- */

/**
 * A complete backend that keeps rows in an array.
 *
 * Used by the tests, and usable by a local dev server that has no database yet. It enforces the two things
 * the database enforces with constraints — sequence numbers are unique and hashes are unique — because a
 * backend that is more permissive than production turns a passing test into a false statement about
 * production.
 */
export class MemoryEventBackend implements EventBackend {
  private readonly rows: EventRow[] = [];
  private readonly hashes = new Set<string>();

  head(): Promise<{ seq: number; hash: string } | null> {
    const last = this.rows[this.rows.length - 1];
    return Promise.resolve(last === undefined ? null : { seq: last.seq, hash: last.hash });
  }

  insert(row: EventRow): Promise<boolean> {
    if (this.hashes.has(row.hash)) return Promise.resolve(false);
    if (this.rows.some((r) => r.seq === row.seq)) return Promise.resolve(false);
    this.rows.push({ ...row, payload: { ...row.payload } });
    this.hashes.add(row.hash);
    return Promise.resolve(true);
  }

  byId(seq: number): Promise<EventRow | null> {
    return Promise.resolve(this.rows.find((r) => r.seq === seq) ?? null);
  }

  range(fromSeq: number, toSeq: number): Promise<EventRow[]> {
    return Promise.resolve(this.rows.filter((r) => r.seq >= fromSeq && r.seq <= toSeq).sort((a, b) => a.seq - b.seq));
  }

  group(groupId: string): Promise<EventRow[]> {
    if (groupId === "") return Promise.resolve([]);
    return Promise.resolve(this.rows.filter((r) => r.groupId === groupId).sort((a, b) => a.seq - b.seq));
  }

  reversedAmong(seqs: readonly number[]): Promise<number[]> {
    const wanted = new Set(seqs);
    const found = new Set<number>();
    for (const row of this.rows) {
      if (row.kind === EVENT.REVERSAL && wanted.has(row.reverses)) found.add(row.reverses);
    }
    return Promise.resolve([...found]);
  }

  restoredAmong(seqs: readonly number[]): Promise<number[]> {
    const wanted = new Set(seqs);
    const found = new Set<number>();
    for (const row of this.rows) {
      if (row.restores > 0 && wanted.has(row.restores)) found.add(row.restores);
    }
    return Promise.resolve([...found]);
  }

  bySubject(subjectId: string): Promise<EventRow[]> {
    return Promise.resolve(this.rows.filter((r) => r.subjectId === subjectId).sort((a, b) => a.seq - b.seq));
  }

  /** Test-only view of everything written. Not part of the backend contract. */
  all(): readonly EventRow[] {
    return this.rows;
  }

  /**
   * Test-only tampering: replace a stored row in place, exactly as a bad migration or a compromised session
   * would. The public path cannot do this, which is why the tamper tests need it — a tripwire that has
   * never been tripped on purpose is a decoration.
   */
  tamper(seq: number, patch: Partial<EventRow>): void {
    const index = this.rows.findIndex((r) => r.seq === seq);
    if (index < 0) return;
    this.rows[index] = { ...(this.rows[index] as EventRow), ...patch };
  }
}
