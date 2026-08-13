/**
 * The door in front of everything admin-only, and the one live log instance behind it.
 *
 * This used to live inside `routes/events.ts`. It moved here the moment a second admin route file existed,
 * because two copies of an access check is how one of them ends up a version behind the other — and the
 * copy that is behind is always the one guarding the newer, less-reviewed endpoints.
 *
 * FAIL CLOSED, ALWAYS. A server with no token configured refuses every admin call rather than serving the
 * log wide open, and the refusal is worded identically whether the token is missing, wrong, or too short
 * to be a secret. Telling a caller which of those it was is how they learn there is something here to
 * attack.
 */

import { ORPCError } from "@orpc/server";
import { timingSafeEqual } from "node:crypto";
import { base } from "../__core/app";
import { EventLog } from "./store";

/** The shortest thing we will treat as a secret. Below this, the server behaves as if unconfigured. */
export const MIN_TOKEN_CHARS = 16;

/** Constant-time compare, so a wrong token cannot be guessed a character at a time. */
function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** Every admin procedure in every route file sits behind this and nothing else. */
export const adminOnly = base.use(({ context, next }) => {
  const expected = process.env.EVENT_LOG_ADMIN_TOKEN ?? "";
  if (expected.length < MIN_TOKEN_CHARS) {
    console.warn("[events] EVENT_LOG_ADMIN_TOKEN is not set — refusing every admin call");
    throw new ORPCError("FORBIDDEN", { message: "The event log is not available." });
  }

  const header = context.headers.get("authorization") ?? "";
  const offered = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (offered === "" || !sameSecret(offered, expected)) {
    throw new ORPCError("FORBIDDEN", { message: "The event log is not available." });
  }

  return next();
});

let instance: EventLog | null = null;

/**
 * The log, built on first use rather than at import.
 *
 * The database client connects when it is imported, and the rules half of the log is deliberately usable
 * with no database at all. Loading it lazily keeps a server with no database configured able to start,
 * serve config, and say a clear no here.
 */
export async function log(): Promise<EventLog> {
  if (instance !== null) return instance;
  const { DbEventBackend } = await import("./backend-db");
  instance = new EventLog(new DbEventBackend());
  return instance;
}
