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
    restores: integer("restores").notNull().default(0),
    groupId: text("group_id").notNull(),
    prevHash: text("prev_hash").notNull(),
    hash: text("hash").notNull(),
  },
  (table) => [
    uniqueIndex("event_log_hash_idx").on(table.hash),
    index("event_log_subject_idx").on(table.subjectId),
    index("event_log_group_idx").on(table.groupId),
    index("event_log_reverses_idx").on(table.reverses),
    index("event_log_restores_idx").on(table.restores),
  ],
);

/**
 * One row per account: the cloud copy of a profile.
 *
 * WHAT THIS TABLE IS AND IS NOT
 *
 * It is a locker, not a referee. The blob is the save bytes exactly as the phone wrote them, base64'd, and
 * the server never opens it — the codec that understands those bytes lives in the game package and reading
 * it here would mean two implementations of one format, which is how a sync starts corrupting saves after a
 * version bump. Merging happens on the device, in `game/save/sync.ts`, where it is tested.
 *
 * The loose columns beside the blob are declared by the client and are for *us*: they let a support screen
 * say "this account has 14 unlocks and 5,000 lifetime gold" without decoding anything, and they let a push
 * be refused for being stale without a round trip through the codec. They are not authority and nothing is
 * granted from them. Anti-cheat reads submitted runs, not this.
 *
 * `generation` is the only ordering rule: a push must carry a higher generation than the row it replaces.
 * Because a merge always produces a generation above both of its inputs, a device that pulls, merges and
 * pushes always wins, and a device that pushes without merging always loses. That is the intended shape —
 * losing a push costs a retry, and losing an unlock costs a player.
 *
 * `ownerHash` is a placeholder for real accounts: the first push for an id records a hash of the device
 * secret that made it, and later pushes must present the same secret. It is a lock on the locker, not a
 * sign-in, and it is replaced wholesale when accounts land.
 */
export const cloudSave = sqliteTable(
  "cloud_save",
  {
    accountId: text("account_id").primaryKey(),
    ownerHash: text("owner_hash").notNull(),
    generation: integer("generation").notNull(),
    saveVersion: integer("save_version").notNull(),
    buildId: integer("build_id").notNull(),
    /** Base64 of the save bytes. Never decoded here — see the note above. */
    blob: text("blob").notNull(),
    bytes: integer("bytes").notNull(),
    /** Client-declared, for support screens only. */
    unlockBits: integer("unlock_bits").notNull(),
    goldLifetime: integer("gold_lifetime").notNull(),
    /** Server wall clock. The client's clock is never stored as truth. */
    updatedAt: integer("updated_at").notNull(),
    pushCount: integer("push_count").notNull().default(0),
  },
  (table) => [index("cloud_save_updated_idx").on(table.updatedAt)],
);
