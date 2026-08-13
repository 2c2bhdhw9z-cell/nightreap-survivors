/**
 * The database implementation of `EventBackend`.
 *
 * Kept apart from `store.ts` so the rules can be tested without a connection: nothing in the rule path
 * imports this file, and this file holds no rules. Every method is a query and a shape conversion, and if
 * one of them ever starts to look like a decision it belongs in `log.ts` where it can be tested.
 *
 * There is no update statement and no delete statement in this file. That is the guarantee, spelled out in
 * SQL by omission.
 */

import { and, asc, desc, eq, gte, inArray, lte } from "drizzle-orm";
import { db } from "../database";
import { eventLog } from "../database/schema";
import type { EventRow, Scalar } from "./log";
import type { EventBackend } from "./store";

type Stored = typeof eventLog.$inferSelect;

/**
 * Read a stored payload back.
 *
 * A payload that will not parse, or that is not a flat object, is read as empty rather than thrown. The row
 * itself still verifies or fails on its hash, which is the check that matters; refusing to *read* a
 * malformed row would mean one bad row hides the whole log from the person trying to work out what
 * happened.
 */
function readPayload(text: string): Record<string, Scalar> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};

  const out: Record<string, Scalar> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value === "string" || typeof value === "boolean") out[key] = value;
    else if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
  }
  return out;
}

function toRow(stored: Stored): EventRow {
  return {
    seq: stored.seq,
    kind: stored.kind,
    actorKind: stored.actorKind,
    actorId: stored.actorId,
    subjectId: stored.subjectId,
    buildId: stored.buildId,
    at: stored.at,
    payload: readPayload(stored.payload),
    reverses: stored.reverses,
    restores: stored.restores,
    groupId: stored.groupId,
    prevHash: stored.prevHash,
    hash: stored.hash,
  };
}

export class DbEventBackend implements EventBackend {
  async head(): Promise<{ seq: number; hash: string } | null> {
    const found = await db.select().from(eventLog).orderBy(desc(eventLog.seq)).limit(1);
    const last = found[0];
    return last === undefined ? null : { seq: last.seq, hash: last.hash };
  }

  /**
   * Write the row.
   *
   * The unique index on the hash is what makes a duplicate a refusal rather than a fork, so a constraint
   * failure is reported as "already there" instead of raised. Any other database error is raised, because
   * a write that failed for a reason we do not understand must not look like a write that succeeded.
   */
  async insert(row: EventRow): Promise<boolean> {
    try {
      await db.insert(eventLog).values({
        seq: row.seq,
        kind: row.kind,
        actorKind: row.actorKind,
        actorId: row.actorId,
        subjectId: row.subjectId,
        buildId: row.buildId,
        at: row.at,
        payload: JSON.stringify(row.payload),
        reverses: row.reverses,
        restores: row.restores,
        groupId: row.groupId,
        prevHash: row.prevHash,
        hash: row.hash,
      });
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("UNIQUE") || message.includes("constraint")) return false;
      throw error;
    }
  }

  async byId(seq: number): Promise<EventRow | null> {
    const found = await db.select().from(eventLog).where(eq(eventLog.seq, seq)).limit(1);
    const row = found[0];
    return row === undefined ? null : toRow(row);
  }

  async range(fromSeq: number, toSeq: number): Promise<EventRow[]> {
    const found = await db
      .select()
      .from(eventLog)
      .where(and(gte(eventLog.seq, fromSeq), lte(eventLog.seq, toSeq)))
      .orderBy(asc(eventLog.seq));
    return found.map(toRow);
  }

  async group(groupId: string): Promise<EventRow[]> {
    if (groupId === "") return [];
    const found = await db.select().from(eventLog).where(eq(eventLog.groupId, groupId)).orderBy(asc(eventLog.seq));
    return found.map(toRow);
  }

  async reversedAmong(seqs: readonly number[]): Promise<number[]> {
    if (seqs.length === 0) return [];
    const found = await db
      .select({ reverses: eventLog.reverses })
      .from(eventLog)
      .where(inArray(eventLog.reverses, [...seqs]));
    const out = new Set<number>();
    for (const row of found) if (row.reverses > 0) out.add(row.reverses);
    return [...out];
  }

  async restoredAmong(seqs: readonly number[]): Promise<number[]> {
    if (seqs.length === 0) return [];
    const found = await db
      .select({ restores: eventLog.restores })
      .from(eventLog)
      .where(inArray(eventLog.restores, [...seqs]));
    const out = new Set<number>();
    for (const row of found) if (row.restores > 0) out.add(row.restores);
    return [...out];
  }

  async bySubject(subjectId: string): Promise<EventRow[]> {
    const found = await db.select().from(eventLog).where(eq(eventLog.subjectId, subjectId)).orderBy(asc(eventLog.seq));
    return found.map(toRow);
  }
}
