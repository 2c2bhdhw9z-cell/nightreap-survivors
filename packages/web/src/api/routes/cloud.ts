/**
 * The cloud locker for a profile: pull the stored copy, push a merged one.
 *
 * WHY THE SERVER DOES NOT MERGE
 *
 * The merge rules — unions for unlocks, high-water marks for totals, a balance reconstructed from lifetime
 * gold minus what the shop holds — live in `packages/mobile/game/save/sync.ts` and are tested there against
 * nineteen deliberate breakages. Implementing them again here would mean two versions of the one rule that
 * decides whether a player keeps their progress, and the day they disagree is the day a save gets quietly
 * halved. So the server stores bytes it never opens, and the device does the thinking.
 *
 * The cost of that choice is that a tampered client can push a tampered profile. That is accepted, on
 * purpose: a save is not authority for anything that matters. Leaderboards are fed by submitted runs, which
 * are revalidated from their replays, and nothing here grants power to anyone else's game. Trading a
 * theoretical cheat for "a sync can never corrupt a save" is the right way round.
 *
 * THE ONE RULE THIS ENDPOINT ENFORCES
 *
 * A push must carry a higher generation than the row it replaces. A merge always produces a generation above
 * both of its inputs, so pull-merge-push always wins and push-without-merging always loses — and losing a
 * push costs a retry, while losing an unlock costs a player. A stale push is answered with the stored row so
 * the device can merge and come straight back rather than making a second call to find out what it missed.
 *
 * WHO MAY CALL THESE
 *
 * There is no sign-in yet. The first push for an account id records a hash of the device secret that made
 * it, and every later call for that id must present the same secret. It is a padlock, not an identity: it
 * stops a stranger who guesses an id from reading or overwriting a stranger's profile, which is the whole
 * job until real accounts land. The wrong secret is answered exactly like an unknown id.
 */

import { ORPCError } from "@orpc/server";
import { createHash, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { base } from "../__core/app";
import { db } from "../database";
import { cloudSave } from "../database/schema";

/** The largest save we will store. A v2 profile is a little over a kilobyte; this is room to grow ten times. */
export const MAX_BLOB_CHARS = 16_384;

/** The shortest device secret we will treat as one. Shorter than this and the padlock is decoration. */
export const MIN_SECRET_CHARS = 24;

/** u32 ceiling, the same one the save's own counters are bounded by. */
const U32_MAX = 4294967295;

const accountId = z
  .string()
  .min(8)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, "an account id is letters, digits, dashes and underscores");

const secret = z.string().min(MIN_SECRET_CHARS).max(256);

/** Base64 with no whitespace, so a blob's length is its length and a padding trick cannot smuggle bytes. */
const blob = z
  .string()
  .min(16)
  .max(MAX_BLOB_CHARS)
  .regex(/^[A-Za-z0-9+/]+={0,2}$/, "a save blob is base64");

const pushInput = z.object({
  accountId,
  secret,
  blob,
  bytes: z.number().int().positive().max(MAX_BLOB_CHARS),
  generation: z.number().int().nonnegative().max(U32_MAX),
  saveVersion: z.number().int().positive().max(4095),
  buildId: z.number().int().nonnegative().max(U32_MAX),
  unlockBits: z.number().int().nonnegative().max(100_000),
  goldLifetime: z.number().int().nonnegative().max(U32_MAX),
});

const pullInput = z.object({ accountId, secret });

/** Hash of a device secret. Stored instead of the secret, for the same reason a password is never stored. */
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
 * One refusal for "no such profile" and for "not yours".
 *
 * Two different answers would turn this endpoint into a way to find out which account ids exist, which is
 * the first step of every attack on a locker like this.
 */
function noProfile(): ORPCError<"NOT_FOUND", undefined> {
  return new ORPCError("NOT_FOUND", { message: "No cloud save for that profile." });
}

interface StoredShape {
  blob: string;
  bytes: number;
  generation: number;
  saveVersion: number;
  buildId: number;
  unlockBits: number;
  goldLifetime: number;
  updatedAt: number;
  pushCount: number;
}

function shapeOf(row: typeof cloudSave.$inferSelect): StoredShape {
  return {
    blob: row.blob,
    bytes: row.bytes,
    generation: row.generation,
    saveVersion: row.saveVersion,
    buildId: row.buildId,
    unlockBits: row.unlockBits,
    goldLifetime: row.goldLifetime,
    updatedAt: row.updatedAt,
    pushCount: row.pushCount,
  };
}

/**
 * Read the stored copy.
 *
 * `found: false` is a normal answer, not an error: a device signing in for the first time has nothing in the
 * locker, and that is the most common call this endpoint will ever serve. An unknown id and a wrong secret
 * are the one refusal above, because those two are not normal.
 */
const pull = base.input(pullInput).handler(async ({ input }) => {
  const rows = await db.select().from(cloudSave).where(eq(cloudSave.accountId, input.accountId)).limit(1);
  const row = rows[0];
  if (row === undefined) return { found: false as const };
  if (!sameHash(row.ownerHash, ownerHashOf(input.secret))) throw noProfile();
  return { found: true as const, save: shapeOf(row) };
});

/**
 * Store a copy, if it is newer than what is there.
 *
 * The three answers a device can get:
 *
 *   - `stored: true` — it is in the locker.
 *   - `stored: false` with the stored row attached — somebody else pushed something newer. Merge that and
 *     push again. This is not an error, it is the ordinary outcome of two phones being played the same day.
 *   - a refusal — the id is not yours, or the payload is not a save.
 *
 * A push that carries the *same* generation as the stored row is refused too. Equal generations mean two
 * different merges landed on the same number, and overwriting one with the other would silently drop
 * whichever lost the race; the device merges the stored copy in and comes back with a higher number.
 */
const push = base.input(pushInput).handler(async ({ input }) => {
  const hash = ownerHashOf(input.secret);
  const rows = await db.select().from(cloudSave).where(eq(cloudSave.accountId, input.accountId)).limit(1);
  const row = rows[0];
  const now = Date.now();

  if (row === undefined) {
    await db.insert(cloudSave).values({
      accountId: input.accountId,
      ownerHash: hash,
      generation: input.generation,
      saveVersion: input.saveVersion,
      buildId: input.buildId,
      blob: input.blob,
      bytes: input.bytes,
      unlockBits: input.unlockBits,
      goldLifetime: input.goldLifetime,
      updatedAt: now,
      pushCount: 1,
    });
    return { stored: true as const, generation: input.generation, created: true as const };
  }

  if (!sameHash(row.ownerHash, hash)) throw noProfile();

  if (input.generation <= row.generation) {
    return { stored: false as const, reason: "stale" as const, save: shapeOf(row) };
  }

  await db
    .update(cloudSave)
    .set({
      generation: input.generation,
      saveVersion: input.saveVersion,
      buildId: input.buildId,
      blob: input.blob,
      bytes: input.bytes,
      unlockBits: input.unlockBits,
      goldLifetime: input.goldLifetime,
      updatedAt: now,
      pushCount: row.pushCount + 1,
    })
    .where(eq(cloudSave.accountId, input.accountId));

  return { stored: true as const, generation: input.generation, created: false as const };
});

export const cloud = {
  pull,
  push,
};
