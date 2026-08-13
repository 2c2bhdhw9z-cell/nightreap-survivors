import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * Define your database schema here, then apply it with `bun run db:push`
 * (from packages/web). Re-export any generated schema from this file
 * (e.g. Better Auth's auth-schema.ts) so drizzle generates complete migrations.
 * Table patterns and conventions: skills/app/references/api.md
 */

/**
 * The append-only event log. See `../events/log.ts` for what every column means and why the table has no
 * update path and no delete path — this is the only table in the app that is written to and never changed.
 *
 * `payload` is JSON text because the shape is per-event-kind and the log has to stay readable by code that
 * has never heard of the kind. It is a flat bag of primitives, enforced before the row is sealed, so the
 * text is always a one-level object.
 *
 * `hash` is unique on purpose: two processes racing to append the same row leaves the loser refused rather
 * than the chain forked.
 */
export const eventLog = sqliteTable(
  "event_log",
  {
    seq: integer("seq").primaryKey({ autoIncrement: true }),
    kind: integer("kind").notNull(),
    actorKind: integer("actor_kind").notNull(),
    actorId: text("actor_id").notNull(),
    subjectId: text("subject_id").notNull(),
    buildId: integer("build_id").notNull(),
    at: integer("at").notNull(),
    payload: text("payload").notNull(),
    reverses: integer("reverses").notNull(),
    groupId: text("group_id").notNull(),
    prevHash: text("prev_hash").notNull(),
    hash: text("hash").notNull(),
  },
  (table) => [
    uniqueIndex("event_log_hash_idx").on(table.hash),
    index("event_log_subject_idx").on(table.subjectId),
    index("event_log_group_idx").on(table.groupId),
    index("event_log_reverses_idx").on(table.reverses),
  ],
);
