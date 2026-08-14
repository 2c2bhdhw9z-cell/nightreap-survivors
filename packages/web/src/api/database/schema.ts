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

/**
 * Submitted runs — the input log, the result claimed with it, and what the server made of the pair.
 *
 * WHY THE LOG IS KEPT AND NOT JUST THE VERDICT
 * A verdict is an opinion produced by a rulebook that is still being written. The log is evidence, and it
 * is the only thing that can ever *prove* a result: replayed tick for tick on the build it was played on,
 * it either lands on the same final state hash or it does not. Keeping the bytes means a rule we get wrong
 * today can be re-run tomorrow on the same run, instead of us having thrown the run away and kept only the
 * mistake. It is also what makes an appeal answerable.
 *
 * The blob is base64 of the exact bytes the phone uploaded, and nothing rewrites it. `verdictJson` beside
 * it is the judgement `anticheat/submission.ts` reached, stored whole rather than as a spread of columns,
 * because a verdict is one document produced by one rulebook version and half of it is meaningless without
 * the rest. The loose columns are the handful of things an operator screen sorts and filters by.
 *
 * A REFUSED SUBMISSION IS STILL A ROW. Refusals are how an attack looks from here: a hundred refused
 * uploads from one account in a minute is the signal, and a server that drops them keeps no signal at all.
 * `refusal` is 0 for an accepted run.
 *
 * Nothing in here grants anything. A run being stored is not a run being trusted, a flag is not a
 * punishment, and the only thing that changes an account is an operator action, which lands in the event
 * log with a name against it.
 */
export const runSubmission = sqliteTable(
  "run_submission",
  {
    /** Server-assigned. The client does not get to name its own submissions. */
    id: integer("id").primaryKey({ autoIncrement: true }),
    accountId: text("account_id").notNull(),
    /** Server wall clock. A submitter's clock is evidence, not ordering. */
    receivedAt: integer("received_at").notNull(),
    /** 0 when the run was accepted; a REFUSE_RUN code otherwise. */
    refusal: integer("refusal").notNull(),
    /** How many flags the verdict carried. The codes live in the verdict document. */
    flagCount: integer("flag_count").notNull(),
    /** Which rulebook judged it. See SUBMIT_LIMITS_VERSION. */
    limitsVersion: integer("limits_version").notNull(),
    ladderEligible: integer("ladder_eligible").notNull(),
    /** Facts read out of the log itself, for sorting and for finding a run again. */
    seed: integer("seed").notNull(),
    stageId: integer("stage_id").notNull(),
    ticks: integer("ticks").notNull(),
    playerCount: integer("player_count").notNull(),
    tainted: integer("tainted").notNull(),
    buildId: integer("build_id").notNull(),
    contentVersion: integer("content_version").notNull(),
    finalStateHash: integer("final_state_hash").notNull(),
    /** The whole verdict, as JSON. One rulebook, one document. */
    verdictJson: text("verdict_json").notNull(),
    /** The result the phone claimed, as JSON. An assertion, kept so it can be argued with later. */
    claimJson: text("claim_json").notNull(),
    /** Base64 of the uploaded log. Never rewritten. Empty when the upload was not a log at all. */
    blob: text("blob").notNull(),
    bytes: integer("bytes").notNull(),
  },
  (table) => [
    index("run_submission_account_idx").on(table.accountId),
    index("run_submission_received_idx").on(table.receivedAt),
    index("run_submission_refusal_idx").on(table.refusal),
  ],
);
