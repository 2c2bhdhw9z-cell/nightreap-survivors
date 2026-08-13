/**
 * Put a few lines into a throwaway copy of the record, so the break-glass page has something to show.
 *
 * The rows are written through the real append path — same rules, same sealing, same chain — because a page
 * tested against rows that were shoved straight into the table would be a page tested against a state the
 * live server can never actually be in.
 *
 * Only ever pointed at a file database made for the test. Run by `admin-page.e2e.py`.
 */

import { DbEventBackend } from "../src/api/events/backend-db";
import { ACTOR, EVENT } from "../src/api/events/log";
import { APPEND, EventLog } from "../src/api/events/store";

const SUBJECT = process.env.SEED_SUBJECT ?? "acct-e2e";

if (!(process.env.DATABASE_URL ?? "").startsWith("file:")) {
  console.error("seed: refusing to run against anything but a local file database");
  process.exit(2);
}

const log = new EventLog(new DbEventBackend());
const now = Date.now();

const rows = [
  { kind: EVENT.ACCOUNT_CREATED, payload: { by: "seed" } },
  { kind: EVENT.GOLD_GRANTED, payload: { amount: 1234, action: "grantGold", reason: "seeded for the page test" } },
  { kind: EVENT.CHAT_BANNED, payload: { forever: true, action: "chatBan", reason: "seeded for the page test" } },
];

let seq = 0;
for (const [index, row] of rows.entries()) {
  const result = await log.append({
    kind: row.kind,
    actorKind: ACTOR.ADMIN,
    actorId: "seed-operator",
    subjectId: SUBJECT,
    buildId: 1000,
    at: now + index,
    payload: row.payload,
    reverses: 0,
    restores: 0,
    groupId: "",
  });
  if (result.status !== APPEND.OK) {
    console.error(`seed: row ${index} refused (${result.reason})`);
    process.exit(2);
  }
  seq = result.row?.seq ?? 0;
}

console.log(`seeded ${rows.length} rows for ${SUBJECT}, last is ${seq}`);
