/**
 * Tests for the append-only event log.
 *
 * The log's whole value is that it can be trusted afterwards, so these tests are about the promises rather
 * than the code: bytes that mean one thing and only one thing, a chain that notices tampering, a reversal
 * that cannot hit a bystander or fire twice, a bulk undo that reports its exceptions instead of abandoning
 * ten thousand accounts, and a projection that can rebuild an account from nothing but rows.
 *
 * Run directly: `bun packages/web/src/api/events/log.test.ts`. Exits non-zero on the first problem, because
 * a check that can report a failure and still exit 0 is not a check.
 */

import {
  ACTOR,
  BAD,
  BAD_NAMES,
  CHAIN,
  CHAIN_NAMES,
  canonical,
  EVENT,
  EVENT_NAMES,
  emptyAccountView,
  foldAccount,
  GENESIS_HASH,
  hashOf,
  isKnownKind,
  LIMITS,
  planGroupReversal,
  REVERSIBLE,
  restoreDraftFor,
  seal,
  storyOf,
  validate,
  validateReversal,
  validateRestore,
  verifyChain,
  type EventDraft,
  type EventRow,
  type Scalar,
  type RestoreFacts,
  type TargetFacts,
} from "./log";
import { APPEND, EventLog, MemoryEventBackend } from "./store";

let failures = 0;
let checks = 0;

function check(what: string, ok: boolean, detail = ""): void {
  checks++;
  if (!ok) {
    failures++;
    console.log(`FAIL ${what}${detail ? ` — ${detail}` : ""}`);
  }
}

function section(name: string): void {
  console.log(`\n-- ${name}`);
}

const T0 = 1_700_000_000_000;

function draftOf(over: Partial<EventDraft> = {}): EventDraft {
  return {
    kind: EVENT.GOLD_GRANTED,
    actorKind: ACTOR.SERVER,
    actorId: "server-1",
    subjectId: "acct-a",
    buildId: 1000,
    at: T0,
    payload: { amount: 100 },
    reverses: 0,
    restores: 0,
    groupId: "",
    ...over,
  };
}

function restoreTargetOf(over: Partial<RestoreFacts> = {}): RestoreFacts {
  return {
    exists: true,
    seq: 2,
    kind: EVENT.REVERSAL,
    subjectId: "acct-a",
    reversedKind: EVENT.GOLD_GRANTED,
    reversedSubjectId: "acct-a",
    alreadyRestored: false,
    ...over,
  };
}

function targetOf(over: Partial<TargetFacts> = {}): TargetFacts {
  return {
    exists: true,
    seq: 1,
    kind: EVENT.GOLD_GRANTED,
    subjectId: "acct-a",
    alreadyReversed: false,
    ...over,
  };
}

/** Build a valid chain of sealed rows from drafts, so tamper tests start from something genuinely correct. */
function chainOf(drafts: readonly EventDraft[]): EventRow[] {
  const rows: EventRow[] = [];
  let prev = GENESIS_HASH;
  drafts.forEach((draft, i) => {
    const row = seal(draft, i + 1, prev);
    rows.push(row);
    prev = row.hash;
  });
  return rows;
}

/* ---- the vocabulary ---------------------------------------------------------------------------- */

section("the vocabulary");
{
  // Compared over the values at runtime: TypeScript refuses to compare two distinct literal-typed
  // constants at all, so a compile-time check here would be no check.
  const kinds = Object.values(EVENT);
  check("every event kind has its own number", new Set(kinds).size === kinds.length, "two kinds share a number, so old rows are ambiguous");
  check("every event kind is a positive whole number", kinds.every((k) => Number.isSafeInteger(k) && k > 0));

  const actors = Object.values(ACTOR);
  check("every actor kind has its own number", new Set(actors).size === actors.length);

  const bad = Object.values(BAD);
  check("every refusal reason has its own number", new Set(bad).size === bad.length);

  const faults = Object.values(CHAIN);
  check("every chain fault has its own number", new Set(faults).size === faults.length);

  check("every kind has a name for a human to read", kinds.every((k) => typeof EVENT_NAMES[k] === "string"));
  check("every refusal reason has a name", bad.every((b) => typeof BAD_NAMES[b] === "string"));
  check("every chain fault has a name", faults.every((f) => typeof CHAIN_NAMES[f] === "string"));

  check("a kind we use is recognised", isKnownKind(EVENT.CHAT_MUTED));
  check("a number nobody has defined is not", isKnownKind(9_999) === false);
  check("and zero is not a kind", isKnownKind(0) === false);

  check("undoing an undo is not allowed", REVERSIBLE.has(EVENT.REVERSAL) === false);
  check("a run arriving cannot be un-arrived", REVERSIBLE.has(EVENT.RUN_SUBMITTED) === false);
  check("somebody's written note cannot be edited away", REVERSIBLE.has(EVENT.ADMIN_NOTE) === false);
  check("creating an account cannot be undone", REVERSIBLE.has(EVENT.ACCOUNT_CREATED) === false);
  check("granting gold can be undone", REVERSIBLE.has(EVENT.GOLD_GRANTED));
  check("a chat ban can be undone", REVERSIBLE.has(EVENT.CHAT_BANNED));
  check("every reversible kind is a real kind", [...REVERSIBLE].every((k) => isKnownKind(k)));
}

/* ---- the bytes a hash is taken over ------------------------------------------------------------ */

section("the bytes a hash is taken over");
{
  const base = { ...draftOf(), seq: 7, prevHash: GENESIS_HASH };

  check("the same facts give the same bytes twice", canonical(base) === canonical({ ...base }));
  check("the bytes say which version wrote them", canonical(base).startsWith("v2|"));

  const keysOneWay = canonical({ ...base, payload: { alpha: 1, beta: 2 } });
  const keysOther = canonical({ ...base, payload: { beta: 2, alpha: 1 } });
  check("the order the payload was written in does not change the bytes", keysOneWay === keysOther, "field order in source could invalidate history");

  const split = canonical({ ...base, payload: { ab: "c" } });
  const other = canonical({ ...base, payload: { a: "bc" } });
  check("two different payloads cannot produce the same bytes", split !== other, "lengths are missing, so different facts can share a hash");

  const asNumber = canonical({ ...base, payload: { v: 1 } });
  const asText = canonical({ ...base, payload: { v: "1" } });
  const asYes = canonical({ ...base, payload: { v: true } });
  check("the number 1 and the text 1 are different facts", asNumber !== asText);
  check("the number 1 and yes are different facts", asNumber !== asYes);
  check("the text 1 and yes are different facts", asText !== asYes);

  // The separator can appear inside an id too, and without the lengths "a|b" then "c" and "a" then "b|c"
  // write the same bytes — two different rows sharing a hash, which is the one hole a tamper-evident log
  // must not have.
  const runOn = canonical({ ...base, actorId: "a|b", subjectId: "c" });
  const shifted = canonical({ ...base, actorId: "a", subjectId: "b|c" });
  check("a separator inside an id cannot be shifted between fields", runOn !== shifted, "the field lengths are missing");

  const pipeInValue = canonical({ ...base, payload: { note: "a|b" } });
  const twoValues = canonical({ ...base, payload: { note: "a", x: "b" } });
  check("a separator inside a value is not mistaken for a separator between values", pipeInValue !== twoValues);

  check("its place in the log is part of its bytes", canonical(base) !== canonical({ ...base, seq: 8 }));
  check("what came before it is part of its bytes", canonical(base) !== canonical({ ...base, prevHash: "a".repeat(64) }));
  check("who did it is part of its bytes", canonical(base) !== canonical({ ...base, actorId: "someone-else" }));
  check("who it is about is part of its bytes", canonical(base) !== canonical({ ...base, subjectId: "acct-b" }));
  check("when it happened is part of its bytes", canonical(base) !== canonical({ ...base, at: T0 + 1 }));
  check("which build is part of its bytes", canonical(base) !== canonical({ ...base, buildId: 1001 }));
  check("which bulk action is part of its bytes", canonical(base) !== canonical({ ...base, groupId: "wave-1" }));

  check("the hash is sixty-four hex characters", /^[0-9a-f]{64}$/.test(hashOf(base)));
  check("the same row hashes the same way twice", hashOf(base) === hashOf({ ...base }));
  check("a changed row hashes differently", hashOf(base) !== hashOf({ ...base, payload: { amount: 101 } }));
  check("the starting hash is obviously not a hash of anything", GENESIS_HASH === "0".repeat(64));
}

/* ---- sealing ----------------------------------------------------------------------------------- */

section("sealing a row");
{
  const draft = draftOf();
  const before = JSON.stringify(draft);
  const row = seal(draft, 1, GENESIS_HASH);

  check("sealing leaves the caller's draft alone", JSON.stringify(draft) === before, "seal mutated its input");
  check("the row keeps its own hash", row.hash === hashOf(row));
  check("the row remembers what came before it", row.prevHash === GENESIS_HASH);
  check("the row knows its place", row.seq === 1);

  const copied = seal(draft, 1, GENESIS_HASH);
  (copied.payload as Record<string, Scalar>).amount = 999;
  check("the row's payload is its own copy", draft.payload.amount === 100, "the row shares a payload with the draft");
}

/* ---- what may be appended at all --------------------------------------------------------------- */

section("what may be appended at all");
{
  check("an ordinary row is fine", validate(draftOf()) === BAD.NONE);

  check("a kind nobody defined is refused", validate(draftOf({ kind: 9_999 })) === BAD.UNKNOWN_KIND);
  check("an actor kind nobody defined is refused", validate(draftOf({ actorKind: 99 })) === BAD.UNKNOWN_ACTOR);
  check("a row nobody can be held to is refused", validate(draftOf({ actorId: "" })) === BAD.NO_ACTOR_ID);

  check("an absurd actor id is refused", validate(draftOf({ actorId: "x".repeat(LIMITS.ACTOR_ID_CHARS + 1) })) === BAD.TOO_LONG);
  check("an absurd account id is refused", validate(draftOf({ subjectId: "x".repeat(LIMITS.SUBJECT_ID_CHARS + 1) })) === BAD.TOO_LONG);
  check("an absurd bulk id is refused", validate(draftOf({ groupId: "x".repeat(LIMITS.GROUP_ID_CHARS + 1) })) === BAD.TOO_LONG);
  check("an id right at the limit is allowed", validate(draftOf({ actorId: "x".repeat(LIMITS.ACTOR_ID_CHARS) })) === BAD.NONE);

  check("a row about the world rather than a person is allowed", validate(draftOf({ kind: EVENT.CONFIG_PUBLISHED, subjectId: "" })) === BAD.NONE);

  check("a time that is not a whole number is refused", validate(draftOf({ at: 1.5 })) === BAD.BAD_TIME);
  check("a time before the epoch is refused", validate(draftOf({ at: -1 })) === BAD.BAD_TIME);
  check("a nonsense time is refused", validate(draftOf({ at: Number.NaN })) === BAD.BAD_TIME);
  check("a nonsense build is refused", validate(draftOf({ buildId: -5 })) === BAD.BAD_BUILD);
  check("no build at all is fine, because jobs have none", validate(draftOf({ buildId: 0 })) === BAD.NONE);

  const manyKeys: Record<string, Scalar> = {};
  for (let i = 0; i <= LIMITS.PAYLOAD_KEYS; i++) manyKeys[`k${i}`] = i;
  check("a payload with too many fields is refused", validate(draftOf({ payload: manyKeys })) === BAD.TOO_MANY_KEYS);

  check("a payload field with no name is refused", validate(draftOf({ payload: { "": 1 } })) === BAD.BAD_PAYLOAD);
  check("an absurd field name is refused", validate(draftOf({ payload: { ["k".repeat(LIMITS.PAYLOAD_KEY_CHARS + 1)]: 1 } })) === BAD.BAD_PAYLOAD);
  check("an absurdly long text value is refused", validate(draftOf({ payload: { note: "x".repeat(LIMITS.PAYLOAD_STRING_CHARS + 1) } })) === BAD.TOO_LONG);
  check("infinity is refused", validate(draftOf({ payload: { amount: Number.POSITIVE_INFINITY } })) === BAD.BAD_PAYLOAD);
  check("a nonsense number is refused", validate(draftOf({ payload: { amount: Number.NaN } })) === BAD.BAD_PAYLOAD);
  check("a nested payload is refused", validate(draftOf({ payload: { inner: { a: 1 } as unknown as Scalar } })) === BAD.BAD_PAYLOAD);
  check("a list inside a payload is refused", validate(draftOf({ payload: { list: [1, 2] as unknown as Scalar } })) === BAD.BAD_PAYLOAD);
  check("nothing-at-all inside a payload is refused", validate(draftOf({ payload: { nope: null as unknown as Scalar } })) === BAD.BAD_PAYLOAD);
  check("a yes or no value is fine", validate(draftOf({ payload: { first: true } })) === BAD.NONE);
  check("an empty payload is fine", validate(draftOf({ payload: {} })) === BAD.NONE);

  check("an undo with nothing to undo is refused", validate(draftOf({ kind: EVENT.REVERSAL })) === BAD.REVERSAL_NEEDS_TARGET);
  check("an ordinary row may not name something to undo", validate(draftOf({ reverses: 3 })) === BAD.REVERSAL_FORBIDDEN);
  check("a negative target is refused", validate(draftOf({ kind: EVENT.REVERSAL, reverses: -1 })) === BAD.REVERSAL_NEEDS_TARGET);
}

/* ---- what may undo what ------------------------------------------------------------------------ */

section("what may undo what");
{
  const undo = draftOf({ kind: EVENT.REVERSAL, reverses: 1, actorKind: ACTOR.ADMIN, actorId: "admin-1", payload: { reason: "exploit" } });

  check("a good undo is allowed", validateReversal(undo, 5, targetOf()) === BAD.NONE);
  check("an undo of something that is not there is refused", validateReversal(undo, 5, targetOf({ exists: false })) === BAD.NO_SUCH_TARGET);
  check("an undo naming the wrong row is refused", validateReversal(undo, 5, targetOf({ seq: 2 })) === BAD.NO_SUCH_TARGET);
  check("an undo of something that has not happened yet is refused", validateReversal(draftOf({ kind: EVENT.REVERSAL, reverses: 9 }), 5, targetOf({ seq: 9 })) === BAD.TARGET_NOT_BEFORE);
  check("an undo of an undo is refused", validateReversal(undo, 5, targetOf({ kind: EVENT.REVERSAL })) === BAD.NOT_REVERSIBLE);
  check("an undo of something that cannot be undone is refused", validateReversal(undo, 5, targetOf({ kind: EVENT.ADMIN_NOTE })) === BAD.NOT_REVERSIBLE);
  check("undoing the same thing twice is refused", validateReversal(undo, 5, targetOf({ alreadyReversed: true })) === BAD.ALREADY_REVERSED);
  check("an undo aimed at the wrong account is refused", validateReversal(undo, 5, targetOf({ subjectId: "acct-b" })) === BAD.SUBJECT_MISMATCH, "a mistyped id could take gold from a bystander");
  check("an ordinary row cannot be used as an undo", validateReversal(draftOf(), 5, targetOf()) === BAD.REVERSAL_FORBIDDEN);
  check("a broken undo fails the ordinary checks first", validateReversal(draftOf({ kind: EVENT.REVERSAL, reverses: 1, actorId: "" }), 5, targetOf()) === BAD.NO_ACTOR_ID);

  // Every refusal reason the log can give must be reachable, or it is decoration.
  const reached = new Set<number>([
    validate(draftOf()),
    validate(draftOf({ kind: 9_999 })),
    validate(draftOf({ actorKind: 99 })),
    validate(draftOf({ actorId: "" })),
    validate(draftOf({ actorId: "x".repeat(200) })),
    validate(draftOf({ at: -1 })),
    validate(draftOf({ buildId: -1 })),
    validate(draftOf({ payload: { "": 1 } })),
    validate(draftOf({ kind: EVENT.REVERSAL })),
    validate(draftOf({ reverses: 1 })),
    validateReversal(undo, 5, targetOf({ kind: EVENT.ADMIN_NOTE })),
    validateReversal(undo, 5, targetOf({ alreadyReversed: true })),
    validateReversal(undo, 5, targetOf({ exists: false })),
    validateReversal(draftOf({ kind: EVENT.REVERSAL, reverses: 9 }), 5, targetOf({ seq: 9 })),
    validateReversal(undo, 5, targetOf({ subjectId: "acct-b" })),
  ]);
  const manyKeys: Record<string, Scalar> = {};
  for (let i = 0; i <= LIMITS.PAYLOAD_KEYS; i++) manyKeys[`k${i}`] = i;
  reached.add(validate(draftOf({ payload: manyKeys })));
  reached.add(validateRestore(draftOf({ restores: 0 }), 9, restoreTargetOf()));
  reached.add(validate(draftOf({ kind: EVENT.REVERSAL, reverses: 1, restores: 2 })));
  reached.add(validateRestore(draftOf({ restores: 2 }), 9, restoreTargetOf({ kind: EVENT.GOLD_GRANTED })));
  reached.add(validateRestore(draftOf({ restores: 2 }), 9, restoreTargetOf({ alreadyRestored: true })));
  reached.add(validateRestore(draftOf({ restores: 2, kind: EVENT.MARKS_GRANTED }), 9, restoreTargetOf()));
  const missing = Object.values(BAD).filter((b) => !reached.has(b));
  check("every refusal the log can give is actually reachable", missing.length === 0, `never reached: ${missing.map((m) => BAD_NAMES[m]).join(", ")}`);
}

/* ---- proving nothing has been edited ----------------------------------------------------------- */

section("proving nothing has been edited");
{
  const rows = chainOf([draftOf(), draftOf({ payload: { amount: 5 } }), draftOf({ kind: EVENT.UNLOCK_GRANTED, payload: { id: "witch" } })]);

  const clean = verifyChain(rows);
  check("an untouched log verifies", clean.ok && clean.fault === CHAIN.OK);
  check("and says how much it checked", clean.checked === 3);
  check("and reports no position", clean.at === -1);
  check("and hands back the last hash", clean.lastHash === (rows[2] as EventRow).hash);
  check("an empty slice verifies against the hash it was given", verifyChain([], "abc").ok && verifyChain([], "abc").lastHash === "abc");

  const edited = rows.map((r) => ({ ...r }));
  (edited[1] as EventRow).payload = { amount: 500_000 };
  const caught = verifyChain(edited);
  check("editing an old row is caught", caught.ok === false && caught.fault === CHAIN.HASH_MISMATCH);
  check("and the position of the edit is reported", caught.at === 1);

  const relinked = rows.map((r) => ({ ...r }));
  (relinked[2] as EventRow).prevHash = "b".repeat(64);
  const broken = verifyChain(relinked);
  check("breaking the link between two rows is caught", broken.ok === false && broken.fault === CHAIN.PREV_MISMATCH && broken.at === 2);

  const missing = [rows[0] as EventRow, rows[2] as EventRow];
  const gap = verifyChain(missing);
  check("a removed row leaves a hole that is caught", gap.ok === false && gap.fault === CHAIN.SEQ_GAP && gap.at === 1);

  const swapped = [rows[1] as EventRow, rows[0] as EventRow];
  const backwards = verifyChain(swapped, (rows[0] as EventRow).hash);
  check("rows out of order are caught", backwards.ok === false && backwards.fault === CHAIN.SEQ_NOT_ASCENDING);

  const wrongStart = verifyChain(rows, "c".repeat(64));
  check("a slice checked against the wrong starting point is caught", wrongStart.ok === false && wrongStart.fault === CHAIN.PREV_MISMATCH && wrongStart.at === 0);

  const slice = verifyChain([rows[1] as EventRow, rows[2] as EventRow], (rows[0] as EventRow).hash);
  check("a slice from the middle verifies on its own", slice.ok, "checking a hundred million rows to ask about last Tuesday is a check nobody runs");

  const stepped = chainOf([draftOf({ at: T0 + 1000 }), draftOf({ at: T0 })]);
  const clock = verifyChain(stepped);
  check("a clock that stepped backwards is still an intact log", clock.ok && clock.fault === CHAIN.OK, "an NTP correction must not stop the log working");
  check("but the oddity is counted", clock.clockSteps === 1);
  check("and a forwards-only log counts none", verifyChain(rows).clockSteps === 0);
}

/* ---- undoing a whole bulk action --------------------------------------------------------------- */

section("undoing a whole bulk action");
{
  const rows = chainOf([
    draftOf({ subjectId: "acct-a", groupId: "wave-1", payload: { amount: 10 } }),
    draftOf({ subjectId: "acct-b", groupId: "wave-1", payload: { amount: 20 } }),
    draftOf({ subjectId: "acct-c", groupId: "wave-1", kind: EVENT.ADMIN_NOTE, payload: { note: "looked wrong" } }),
    draftOf({ subjectId: "acct-d", groupId: "wave-1", payload: { amount: 40 } }),
    draftOf({ subjectId: "acct-e", groupId: "other", payload: { amount: 50 } }),
  ]);

  const plan = planGroupReversal(rows, "wave-1", new Set([2]), ACTOR.ADMIN, "admin-1", T0 + 5000, "bad wave", "undo-1");

  check("the plan covers the group and nothing else", plan.drafts.every((d) => d.subjectId !== "acct-e"));
  check("it undoes what it can", plan.drafts.length === 2);
  check("it starts with the newest thing that happened", (plan.drafts[0] as EventDraft).reverses === 4, "reversing oldest-first walks a balance through states that never happened");
  check("and works backwards", (plan.drafts[1] as EventDraft).reverses === 1);
  check("a row that cannot be undone is reported, not fatal", plan.skipped.some((s) => s.seq === 3 && s.reason === BAD.NOT_REVERSIBLE));
  check("a row already undone is reported, not fatal", plan.skipped.some((s) => s.seq === 2 && s.reason === BAD.ALREADY_REVERSED), "one bad row must not leave the other accounts punished");
  check("every draft is an undo", plan.drafts.every((d) => d.kind === EVENT.REVERSAL));
  check("every draft is about the same account as its target", plan.drafts.every((d) => d.subjectId === (rows.find((r) => r.seq === d.reverses) as EventRow).subjectId));
  check("every draft carries the reason", plan.drafts.every((d) => d.payload.reason === "bad wave"));
  check("every draft can be read without fetching its target", plan.drafts.every((d) => typeof d.payload.ofKind === "number" && d.payload.ofGroup === "wave-1"));
  check("the undo is itself one action", plan.drafts.every((d) => d.groupId === "undo-1"));
  check("every draft would pass the ordinary checks", plan.drafts.every((d) => validate(d) === BAD.NONE));

  const nothing = planGroupReversal(rows, "", new Set(), ACTOR.ADMIN, "admin-1", T0, "x", "undo-2");
  check("undoing no group at all does nothing", nothing.drafts.length === 0 && nothing.skipped.length === 0, "an empty group id must not mean every lone row in the log");

  const unknown = planGroupReversal(rows, "never-happened", new Set(), ACTOR.ADMIN, "admin-1", T0, "x", "undo-3");
  check("undoing a group that does not exist does nothing", unknown.drafts.length === 0);
}

/* ---- rebuilding an account from the log alone -------------------------------------------------- */

section("rebuilding an account from the log alone");
{
  const empty = emptyAccountView();
  check("a brand new account owns nothing", empty.gold === 0 && empty.marks === 0 && empty.unlocks === 0);
  check("and is in no trouble", !empty.muted && !empty.chatBanned && !empty.flagged && !empty.segregated && empty.strikes === 0);

  const rows = chainOf([
    draftOf({ subjectId: "acct-a", kind: EVENT.GOLD_GRANTED, payload: { amount: 500 } }),
    draftOf({ subjectId: "acct-a", kind: EVENT.GOLD_SPENT, payload: { amount: 120 } }),
    draftOf({ subjectId: "acct-a", kind: EVENT.POWERUP_PURCHASED, payload: { amount: 80, id: "might" } }),
    draftOf({ subjectId: "acct-a", kind: EVENT.UNLOCK_GRANTED, payload: { id: "witch" } }),
    draftOf({ subjectId: "acct-a", kind: EVENT.MARKS_GRANTED, payload: { amount: 30 } }),
    draftOf({ subjectId: "acct-a", kind: EVENT.SEASON_PAID, payload: { amount: 15 } }),
    draftOf({ subjectId: "acct-a", kind: EVENT.MARKS_SPENT, payload: { amount: 5 } }),
    draftOf({ subjectId: "acct-a", kind: EVENT.RUN_ACCEPTED, payload: { runId: "r1" } }),
    draftOf({ subjectId: "acct-a", kind: EVENT.RUN_REVOKED, payload: { runId: "r1" } }),
    draftOf({ subjectId: "acct-b", kind: EVENT.GOLD_GRANTED, payload: { amount: 9_999 } }),
  ]);

  const view = foldAccount(rows, "acct-a");
  check("gold adds up", view.gold === 300, `read ${view.gold}`);
  check("marks add up", view.marks === 40, `read ${view.marks}`);
  check("unlocks are counted", view.unlocks === 1);
  check("accepted runs are counted", view.runsAccepted === 1);
  check("revoked runs are counted", view.runsRevoked === 1);
  check("somebody else's rows are ignored", view.gold !== 10_299);
  check("it says how many rows it read", view.events === 9);

  const withUndo = [
    ...rows,
    seal(
      draftOf({ subjectId: "acct-a", kind: EVENT.REVERSAL, reverses: 1, payload: { reason: "exploit" } }),
      11,
      (rows[9] as EventRow).hash,
    ),
  ];
  const undone = foldAccount(withUndo, "acct-a");
  check("an undone grant contributes nothing", undone.gold === -200, `read ${undone.gold}`);
  check("and the undone row is counted as undone", undone.reversed === 1);
  check("the original row is still there", withUndo.some((r) => r.seq === 1), "nothing is ever removed");

  const mod = chainOf([
    draftOf({ subjectId: "acct-c", kind: EVENT.CHAT_STRIKE, payload: { tier: 1 } }),
    draftOf({ subjectId: "acct-c", kind: EVENT.CHAT_STRIKE, payload: { tier: 1 } }),
    draftOf({ subjectId: "acct-c", kind: EVENT.CHAT_MUTED, payload: { hours: 24 } }),
    draftOf({ subjectId: "acct-c", kind: EVENT.CHAT_BANNED, payload: { forever: true } }),
    draftOf({ subjectId: "acct-c", kind: EVENT.ACCOUNT_FLAGGED, payload: { why: "impossible dps" } }),
    draftOf({ subjectId: "acct-c", kind: EVENT.ACCOUNT_SEGREGATED, payload: { why: "impossible dps" } }),
  ]);
  const introuble = foldAccount(mod, "acct-c");
  check("strikes are counted", introuble.strikes === 2);
  check("a mute is remembered", introuble.muted);
  check("a chat ban is remembered", introuble.chatBanned);
  check("a flag is remembered", introuble.flagged);
  check("being kept away from the ladders is remembered", introuble.segregated);

  const cleared = foldAccount([...mod, seal(draftOf({ subjectId: "acct-c", kind: EVENT.CHAT_CLEARED, payload: { by: "appeal" } }), 7, (mod[5] as EventRow).hash)], "acct-c");
  check("clearing chat lifts the mute", cleared.muted === false);
  check("and the ban", cleared.chatBanned === false);
  check("and the strikes", cleared.strikes === 0);
  check("but not the account flag, which is a different matter", cleared.flagged);

  const restored = foldAccount([...mod, seal(draftOf({ subjectId: "acct-c", kind: EVENT.ACCOUNT_RESTORED, payload: { by: "appeal" } }), 7, (mod[5] as EventRow).hash)], "acct-c");
  check("restoring an account lifts the flag", restored.flagged === false);
  check("and puts them back on the ladders", restored.segregated === false);

  const nonsense = foldAccount(chainOf([draftOf({ subjectId: "acct-d", payload: { note: "no amount here" } })]), "acct-d");
  check("a grant with no amount adds nothing rather than breaking", nonsense.gold === 0);
}

/* ---- the store: appending for real ------------------------------------------------------------- */

section("the store: appending for real");
{
  const backend = new MemoryEventBackend();
  const log = new EventLog(backend);

  const first = await log.append(draftOf({ payload: { amount: 100 } }));
  check("the first row is accepted", first.status === APPEND.OK);
  check("and is the first in the log", first.row?.seq === 1);
  check("and commits to the starting hash", first.row?.prevHash === GENESIS_HASH);

  const second = await log.append(draftOf({ payload: { amount: 200 } }));
  check("the next row follows it", second.row?.seq === 2);
  check("and commits to the one before", second.row?.prevHash === first.row?.hash);

  const refused = await log.append(draftOf({ kind: 9_999 }));
  check("a bad row is refused", refused.status === APPEND.REFUSED && refused.reason === BAD.UNKNOWN_KIND);
  check("and leaves no trace", backend.all().length === 2, "a refused write must not consume a place in the log");

  // The same facts appended twice are not the same row — the second one sits in a different place in the
  // chain, so it hashes differently and is a genuine second event. The duplicate path exists for the other
  // case: two server processes racing to write the same place, where the loser must be refused rather than
  // allowed to fork the chain.
  const raced = await backend.insert(first.row as EventRow);
  check("a row already in the log cannot be written again", raced === false, "a second copy of a row would fork the chain");
  check("and nothing was added by trying", backend.all().length === 2);

  const clean = await log.verify(1, 100);
  check("the log verifies", clean.ok, CHAIN_NAMES[clean.fault] ?? "");
  check("and it checked both rows", clean.checked === 2);

  const read = await log.read(1, 100);
  check("reading gives them back in order", read.length === 2 && (read[0] as EventRow).seq === 1 && (read[1] as EventRow).seq === 2);
  check("reading backwards gives nothing", (await log.read(5, 2)).length === 0);
  check("reading before the beginning is harmless", (await log.read(-10, 1)).length === 1);
}

section("the store: a lost race is refused, not forked");
{
  // Two server processes can read the same head and both try to write the same place in the chain. The
  // database's unique index decides; the loser must come back as "already there" and must not be counted
  // as written. Modelled here with a backend that refuses the write the way that index would.
  const inner = new MemoryEventBackend();
  const loser = {
    head: () => inner.head(),
    insert: () => Promise.resolve(false),
    byId: (seq: number) => inner.byId(seq),
    range: (from: number, to: number) => inner.range(from, to),
    group: (id: string) => inner.group(id),
    reversedAmong: (seqs: readonly number[]) => inner.reversedAmong(seqs),
    restoredAmong: (seqs: readonly number[]) => inner.restoredAmong(seqs),
    bySubject: (id: string) => inner.bySubject(id),
  };

  const log = new EventLog(loser);
  const result = await log.append(draftOf());
  check("losing the race is reported as already there", result.status === APPEND.DUPLICATE);
  check("and not as a refusal", result.reason === BAD.NONE);
  check("and nothing was stored", inner.all().length === 0);
}

section("the store: appends never interleave");
{
  const backend = new MemoryEventBackend();
  const log = new EventLog(backend);

  const results = await Promise.all(Array.from({ length: 25 }, (_, i) => log.append(draftOf({ payload: { amount: i } }))));
  check("every one of twenty-five at once was written", results.every((r) => r.status === APPEND.OK));

  const seqs = results.map((r) => r.row?.seq ?? 0).sort((a, b) => a - b);
  check("no two rows claim the same place", new Set(seqs).size === 25, "two appends read the same head");
  check("the places run 1 to 25 with no holes", seqs.every((s, i) => s === i + 1));

  const report = await log.verify(1, 100);
  check("and the chain is intact", report.ok, CHAIN_NAMES[report.fault] ?? "");
}

section("the store: tampering is caught");
{
  const backend = new MemoryEventBackend();
  const log = new EventLog(backend);
  await log.append(draftOf({ payload: { amount: 10 } }));
  await log.append(draftOf({ payload: { amount: 20 } }));
  await log.append(draftOf({ payload: { amount: 30 } }));

  check("intact before tampering", (await log.verify(1, 100)).ok);
  backend.tamper(2, { payload: { amount: 1_000_000 } });
  const caught = await log.verify(1, 100);
  check("editing a stored row is caught", caught.ok === false && caught.fault === CHAIN.HASH_MISMATCH);
  check("and it names where", caught.at === 1);
  check("a slice that avoids the edit still verifies", (await log.verify(3, 3)).ok, "a slice must be checkable against the row before it");
}

section("the store: a slice is checked against the row before it");
{
  const backend = new MemoryEventBackend();
  const log = new EventLog(backend);
  await log.append(draftOf({ payload: { amount: 1 } }));
  await log.append(draftOf({ payload: { amount: 2 } }));

  check("a middle slice verifies", (await log.verify(2, 2)).ok);
  const orphan = await log.verify(9, 9);
  check("a slice with nothing in it and no predecessor is empty", orphan.checked === 0);

  backend.tamper(1, { hash: "d".repeat(64) });
  const broken = await log.verify(2, 2);
  check("a slice whose predecessor was edited does not quietly pass", broken.ok === false && broken.fault === CHAIN.PREV_MISMATCH, "checking a slice against its own first row is a check that cannot fail");
}

section("the store: undoing through the front door");
{
  const backend = new MemoryEventBackend();
  const log = new EventLog(backend);
  const grant = await log.append(draftOf({ subjectId: "acct-a", payload: { amount: 500 } }));
  const seq = grant.row?.seq ?? 0;

  const undo = draftOf({
    kind: EVENT.REVERSAL,
    subjectId: "acct-a",
    actorKind: ACTOR.ADMIN,
    actorId: "admin-1",
    reverses: seq,
    payload: { reason: "exploit" },
  });

  const done = await log.append(undo);
  check("an undo is a row like any other", done.status === APPEND.OK && done.row?.kind === EVENT.REVERSAL);

  const twice = await log.append({ ...undo, at: T0 + 1 });
  check("undoing the same row again is refused", twice.status === APPEND.REFUSED && twice.reason === BAD.ALREADY_REVERSED);

  const undoTheUndo = await log.append({ ...undo, reverses: done.row?.seq ?? 0, at: T0 + 2 });
  check("undoing an undo is refused", undoTheUndo.status === APPEND.REFUSED && undoTheUndo.reason === BAD.NOT_REVERSIBLE);

  const nothing = await log.append({ ...undo, reverses: 999, at: T0 + 3 });
  check("undoing a row that is not there is refused", nothing.status === APPEND.REFUSED && nothing.reason === BAD.NO_SUCH_TARGET);

  // A fresh grant, so this is a target nothing has undone yet — otherwise the log refuses it for the
  // earlier reason and the subject check goes untested.
  const other = await log.append(draftOf({ subjectId: "acct-a", payload: { amount: 7 }, at: T0 + 4 }));
  const bystander = await log.append({ ...undo, subjectId: "acct-b", reverses: other.row?.seq ?? 0, at: T0 + 5 });
  check("undoing on behalf of the wrong account is refused", bystander.status === APPEND.REFUSED && bystander.reason === BAD.SUBJECT_MISMATCH, "a mistyped id could take gold from a bystander");

  const view = await log.accountView("acct-a");
  check("the undone grant is gone from the standing", view.gold === 7, `read ${view.gold}`);
  check("every row is still in the log", backend.all().length === 3);
  check("and the log still verifies", (await log.verify(1, 100)).ok);
}

section("the store: undoing a whole wave");
{
  const backend = new MemoryEventBackend();
  const log = new EventLog(backend);

  for (let i = 0; i < 5; i++) {
    await log.append(draftOf({ subjectId: `acct-${i}`, groupId: "wave-1", kind: EVENT.CHAT_BANNED, payload: { forever: true } }));
  }
  await log.append(draftOf({ subjectId: "acct-x", groupId: "other", kind: EVENT.CHAT_BANNED, payload: { forever: true } }));
  await log.append(draftOf({ subjectId: "acct-9", groupId: "wave-1", kind: EVENT.ADMIN_NOTE, payload: { note: "manual" } }));

  const preview = await log.planReversal("wave-1", ACTOR.ADMIN, "admin-1", T0 + 100, "bad wave", "preview");
  check("the preview covers the five bans", preview.drafts.length === 5);
  check("the preview writes nothing", backend.all().length === 7, "a preview that writes is not a preview");
  check("the note is reported as not undoable", preview.skipped.some((s) => s.reason === BAD.NOT_REVERSIBLE));

  const done = await log.reverseGroup("wave-1", ACTOR.ADMIN, "admin-1", T0 + 200, "bad wave", "undo-1");
  check("all five were undone", done.appended.length === 5);
  check("the note was skipped with a reason", done.skipped.some((s) => s.reason === BAD.NOT_REVERSIBLE));
  check("the undos are tied together as one action", done.appended.every((r) => r.groupId === "undo-1"));
  check("the log still verifies afterwards", (await log.verify(1, 200)).ok);

  const banned = await log.accountView("acct-0");
  check("an unfairly banned player is no longer banned", banned.chatBanned === false);
  const other = await log.accountView("acct-x");
  check("a ban outside the wave stands", other.chatBanned);

  const secondTime = await log.reverseGroup("wave-1", ACTOR.ADMIN, "admin-1", T0 + 300, "again", "undo-2");
  check("undoing the same wave twice does nothing new", secondTime.appended.length === 0);
  check("and says why for every row", secondTime.skipped.length === 6);
}

/* ---- the redo ---------------------------------------------------------------------------------- */

section("a redo is a new action, not an un-undo");
{
  const good = draftOf({ restores: 2, at: T0 + 5 });
  check("putting back what an undo took away is allowed", validateRestore(good, 9, restoreTargetOf()) === BAD.NONE, BAD_NAMES[validateRestore(good, 9, restoreTargetOf())] ?? "");

  check(
    "a redo that names nothing is refused",
    validate(draftOf({ restores: 0 })) === BAD.NONE && validateRestore(draftOf({ restores: 0 }), 9, restoreTargetOf()) === BAD.RESTORE_NEEDS_TARGET,
  );
  check("a redo naming a row that is not there is refused", validateRestore(good, 9, restoreTargetOf({ exists: false })) === BAD.NO_SUCH_TARGET);
  check("a redo naming a different row than it says is refused", validateRestore(good, 9, restoreTargetOf({ seq: 3 })) === BAD.NO_SUCH_TARGET);
  check("a redo cannot name a row that comes after it", validateRestore(draftOf({ restores: 9 }), 9, restoreTargetOf({ seq: 9 })) === BAD.TARGET_NOT_BEFORE);

  check(
    "a redo must name an undo, not just any row",
    validateRestore(good, 9, restoreTargetOf({ kind: EVENT.GOLD_GRANTED, reversedKind: 0 })) === BAD.NOT_A_REVERSAL,
    "otherwise the link becomes a made-up justification for a plain handout",
  );
  check(
    "a redo must put back the same kind of thing that was taken away",
    validateRestore(draftOf({ restores: 2, kind: EVENT.MARKS_GRANTED }), 9, restoreTargetOf()) === BAD.RESTORE_KIND_MISMATCH,
    "'I undid a mute, so here is gold' is not a redo",
  );
  check(
    "a redo must be about the same account as the undo",
    validateRestore(draftOf({ restores: 2, subjectId: "acct-b" }), 9, restoreTargetOf()) === BAD.SUBJECT_MISMATCH,
  );
  check(
    "a redo must be about the same account as the original row",
    validateRestore(good, 9, restoreTargetOf({ reversedSubjectId: "acct-b" })) === BAD.SUBJECT_MISMATCH,
  );
  check("the same undo cannot be put back twice", validateRestore(good, 9, restoreTargetOf({ alreadyRestored: true })) === BAD.ALREADY_RESTORED);

  check("an undo cannot also be a redo", validate(draftOf({ kind: EVENT.REVERSAL, reverses: 1, restores: 2 })) === BAD.RESTORE_FORBIDDEN);
  check(
    "a redo has to be a kind that can itself be undone",
    validate(draftOf({ kind: EVENT.ADMIN_NOTE, restores: 2, payload: { note: "x" } })) === BAD.NOT_REVERSIBLE,
    "otherwise the first redo would be a one-way door",
  );
  check("a nonsense redo link is refused", validate(draftOf({ restores: -1 })) === BAD.RESTORE_NEEDS_TARGET);
  check("the redo link is part of a row's bytes", canonical({ ...draftOf(), seq: 7, prevHash: GENESIS_HASH }) !== canonical({ ...draftOf({ restores: 2 }), seq: 7, prevHash: GENESIS_HASH }));
}

section("the store: undo, redo, undo again, forever");
{
  const backend = new MemoryEventBackend();
  const log = new EventLog(backend);

  const grant = await log.append(draftOf({ payload: { amount: 500 } }));
  const grantSeq = grant.row?.seq ?? 0;
  const undo = await log.append(draftOf({ kind: EVENT.REVERSAL, reverses: grantSeq, payload: { reason: "mistake" }, at: T0 + 1 }));
  const undoSeq = undo.row?.seq ?? 0;
  check("the gold is gone after the undo", (await log.accountView("acct-a")).gold === 0);

  const redo = await log.append(restoreDraftFor(grant.row as EventRow, undo.row as EventRow, ACTOR.ADMIN, "admin-1", T0 + 2, "the undo was wrong"));
  check("the redo was accepted", redo.status === APPEND.OK, BAD_NAMES[redo.reason] ?? "");
  check("the gold is back", (await log.accountView("acct-a")).gold === 500, `read ${(await log.accountView("acct-a")).gold}`);
  check("the redo is a plain row of the original kind", redo.row?.kind === EVENT.GOLD_GRANTED);
  check("the redo carries the amount from the original, not from the caller", redo.row?.payload.amount === 500);
  check("the redo says why it exists", redo.row?.payload.restoreReason === "the undo was wrong" && redo.row?.payload.undoneBySeq === undoSeq);
  check("the redo names the undo it puts back", redo.row?.restores === undoSeq);
  check("nothing was rewritten to make it happen", backend.all().length === 3);

  const twice = await log.restore(undoSeq, ACTOR.ADMIN, "admin-1", T0 + 3, "again");
  check("the same undo cannot be put back a second time", twice.status === APPEND.REFUSED && twice.reason === BAD.ALREADY_RESTORED);

  const undoTheRedo = await log.append(draftOf({ kind: EVENT.REVERSAL, reverses: redo.row?.seq ?? 0, payload: { reason: "no, it was right" }, at: T0 + 4 }));
  check("the redo can itself be undone", undoTheRedo.status === APPEND.OK, BAD_NAMES[undoTheRedo.reason] ?? "");
  check("and the gold goes away again", (await log.accountView("acct-a")).gold === 0);

  const redoAgain = await log.restore(undoTheRedo.row?.seq ?? 0, ACTOR.ADMIN, "admin-1", T0 + 5, "third thoughts");
  check("and it can be put back again — there is no ceiling", redoAgain.status === APPEND.OK, BAD_NAMES[redoAgain.reason] ?? "");
  check("the gold is back once more", (await log.accountView("acct-a")).gold === 500);
  check("the whole history still verifies", (await log.verify(1, 100)).ok);
  check("and every step is still there", backend.all().length === 5);

  const notAnUndo = await log.restore(grantSeq, ACTOR.ADMIN, "admin-1", T0 + 6, "wrong row");
  check("pointing a redo at a row that undid nothing is refused", notAnUndo.status === APPEND.REFUSED && notAnUndo.reason === BAD.NOT_A_REVERSAL);
  const nowhere = await log.restore(999, ACTOR.ADMIN, "admin-1", T0 + 7, "nowhere");
  check("putting back an undo that does not exist is refused", nowhere.status === APPEND.REFUSED && nowhere.reason === BAD.NO_SUCH_TARGET);

  const story = await log.story(grantSeq);
  check("the story has all five steps", story.length === 5, `read ${story.length}`);
  check("it starts with the thing that was done", story[0]?.role === "did" && story[0]?.seq === grantSeq);
  check("then reads undone, redone, undone, redone", story.map((s) => s.role).join(",") === "did,undid,redid,undid,redid", story.map((s) => s.role).join(","));
  check("the steps are in the order they happened", story.every((s, i) => i === 0 || s.seq > (story[i - 1]?.seq ?? 0)));
  check("it says who did each step", story.every((s) => s.actorId.length > 0));

  const fromTheMiddle = await log.story(undoSeq);
  check("the same story comes back from any row in it", JSON.stringify(fromTheMiddle) === JSON.stringify(story), "an operator should not have to find the first row themselves");
}

section("the story walk on its own");
{
  check("a row nobody touched is a one-step story", storyOf([], 1).length === 0);
  check("a story about a row that is not there is empty", storyOf([], 5).length === 0);
}

/* ---- how it reads to a human ------------------------------------------------------------------- */

section("how it reads to a human");
{
  const names = Object.values(EVENT).map((k) => EVENT_NAMES[k] ?? "");
  check("every event name is upper case with underscores", names.every((n) => /^[A-Z][A-Z_]*$/.test(n)));
  check("no two events share a name", new Set(names).size === names.length);
  check("no name is empty", names.every((n) => n.length > 0));
}

/* ---- done -------------------------------------------------------------------------------------- */

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.log(`FAIL — ${failures} problem(s) in the event log`);
  const host = globalThis as unknown as { process?: { exit?: (code: number) => void } };
  host.process?.exit?.(1);
} else {
  console.log("PASS — the event log");
}
