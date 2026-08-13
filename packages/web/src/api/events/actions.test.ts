/**
 * Tests for the break-glass action catalogue.
 *
 * Two jobs. First: the catalogue and the log cannot drift apart — every button writes a kind the log knows,
 * no two buttons write the same kind, and every draft the catalogue produces is one the log will actually
 * accept, checked by handing it to the log's own validator rather than to a copy of its rules. Second: a
 * request that is wrong is refused for the right reason and never quietly repaired, because a repaired
 * admin action is an admin action nobody agreed to.
 *
 * Run directly: `bun packages/web/src/api/events/actions.test.ts`.
 */

import {
  ACTION_LIMITS,
  ACTIONS,
  buildAction,
  catalogueFaults,
  describeActions,
  MUTE_HOURS,
  REFUSE,
  REFUSE_NAMES,
  type ActionRequest,
} from "./actions";
import { ACTOR, EVENT, isKnownKind, REVERSIBLE, validate, BAD, type Scalar } from "./log";

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

const NOW = 1_786_600_000_000;
const REASON = "chargeback reversal, ticket 4417";

/** A request that is correct in every way except what a test deliberately changes. */
function request(actionId: string, over: Partial<ActionRequest> = {}): ActionRequest {
  const spec = ACTIONS[actionId];
  const fields: Record<string, Scalar> = {};
  if (spec !== undefined) {
    for (const [name, field] of Object.entries(spec.fields)) {
      if (field.type === "id") fields[name] = `${name}-9`;
      else if (field.type === "oneOf") fields[name] = field.values[0] as number;
      else fields[name] = 250;
    }
  }
  return {
    actionId,
    actorId: "brett",
    subjectId: spec?.aboutAnAccount === false ? "" : "acct-1",
    reason: REASON,
    at: NOW,
    fields,
    groupId: "",
    ...over,
  };
}

function refusalOf(result: ReturnType<typeof buildAction>): string {
  return result.ok ? "ACCEPTED" : `${REFUSE_NAMES[result.refusal]}@${result.field}`;
}

/* ---- the catalogue agrees with the log --------------------------------------------------------- */

section("the catalogue cannot drift from the log");
{
  const faults = catalogueFaults();
  check("the catalogue reports no faults", faults.length === 0, faults.join(" | "));

  const ids = Object.keys(ACTIONS);
  check("there are actions to test at all", ids.length >= 10, `${ids.length} actions`);

  for (const id of ids) {
    const spec = ACTIONS[id];
    if (spec === undefined) {
      check(`${id} exists`, false);
      continue;
    }
    check(`${id} writes a kind the log knows`, isKnownKind(spec.kind), `kind ${spec.kind}`);

    // The real test of agreement: build the row and let the log itself rule on it.
    const built = buildAction(request(id));
    if (!built.ok) {
      check(`${id} builds a row from a correct request`, false, refusalOf(built));
      continue;
    }
    const verdict = validate(built.draft);
    check(`${id} builds a row the log accepts`, verdict === BAD.NONE, `log said ${verdict}`);
    check(`${id} is recorded as an admin action`, built.draft.actorKind === ACTOR.ADMIN);
    check(`${id} undoes nothing and restores nothing`, built.draft.reverses === 0 && built.draft.restores === 0);
    check(`${id} names itself in its own payload`, built.draft.payload.action === id);
    check(`${id} carries its reason`, built.draft.payload.reason === REASON);
  }

  const kinds = new Set(Object.values(ACTIONS).map((spec) => spec.kind));
  check("no two actions write the same kind", kinds.size === Object.keys(ACTIONS).length, `${kinds.size} kinds`);
  check("no action writes a reversal", !kinds.has(EVENT.REVERSAL));
  check("no action claims a run arrived", !kinds.has(EVENT.RUN_SUBMITTED));
}

/* ---- what the screen is told ------------------------------------------------------------------- */

section("the screen draws itself from the catalogue");
{
  const described = describeActions();
  check("every action is described", described.length === Object.keys(ACTIONS).length);

  for (const entry of described) {
    const spec = ACTIONS[entry.id];
    if (spec === undefined) {
      check(`${entry.id} is a real action`, false);
      continue;
    }
    check(
      `${entry.id}'s undoable answer comes from the log's own set`,
      entry.undoable === REVERSIBLE.has(spec.kind),
    );
    check(`${entry.id} lists exactly its fields`, entry.fields.length === Object.keys(spec.fields).length);
    if (!entry.undoable) {
      check(`${entry.id} warns that it cannot be undone`, entry.note.length > 20, `note "${entry.note}"`);
    } else {
      check(`${entry.id} carries no false warning`, entry.note === "");
    }
  }

  // Both halves have to be present, or one of the two branches above has never run.
  const oneWay = described.filter((entry) => !entry.undoable).length;
  check(
    "the catalogue has both undoable and one-way actions",
    oneWay > 0 && oneWay < described.length,
    `${oneWay} of ${described.length} are one-way`,
  );

  const mute = described.find((entry) => entry.id === "chatMute");
  check("the mute button offers a ladder, not a free number", mute?.fields[0]?.values.length === MUTE_HOURS.length);
}

/* ---- the reason ------------------------------------------------------------------------------- */

section("a reason has to be a sentence");
{
  const tooShort = buildAction(request("flagAccount", { reason: "cheat" }));
  check("a five-letter reason is refused", !tooShort.ok && tooShort.refusal === REFUSE.REASON_TOO_THIN, refusalOf(tooShort));

  const heldDown = buildAction(request("flagAccount", { reason: "aaaaaaaaaaaaaa" }));
  check("one character held down is refused", !heldDown.ok && heldDown.refusal === REFUSE.REASON_TOO_THIN, refusalOf(heldDown));

  const spaces = buildAction(request("flagAccount", { reason: "          " }));
  check("whitespace is not a reason", !spaces.ok && spaces.refusal === REFUSE.REASON_TOO_THIN, refusalOf(spaces));

  const padded = buildAction(request("flagAccount", { reason: `   ${REASON}   ` }));
  check("a padded reason is accepted and stored trimmed", padded.ok && padded.draft.payload.reason === REASON);

  const shortest = buildAction(request("flagAccount", { reason: "ab".repeat(ACTION_LIMITS.REASON_MIN_CHARS / 2) }));
  check("a reason at the minimum length is accepted", shortest.ok, refusalOf(shortest));

  const huge = buildAction(request("flagAccount", { reason: `${REASON} ${"x".repeat(ACTION_LIMITS.REASON_MAX_CHARS)}` }));
  check("an enormous reason is refused", !huge.ok && huge.refusal === REFUSE.FIELD_TOO_LONG, refusalOf(huge));
}

/* ---- who and about whom ----------------------------------------------------------------------- */

section("who did it and who it is about");
{
  const noActor = buildAction(request("flagAccount", { actorId: "   " }));
  check("an action with nobody's name on it is refused", !noActor.ok && noActor.refusal === REFUSE.NO_ACTOR, refusalOf(noActor));

  const noSubject = buildAction(request("chatBan", { subjectId: "" }));
  check("a punishment with no account is refused", !noSubject.ok && noSubject.refusal === REFUSE.SUBJECT_REQUIRED, refusalOf(noSubject));

  const worldWithSubject = buildAction(request("quarantineBuild", { subjectId: "acct-1" }));
  check(
    "a build quarantine cannot be pinned on one player",
    !worldWithSubject.ok && worldWithSubject.refusal === REFUSE.SUBJECT_FORBIDDEN,
    refusalOf(worldWithSubject),
  );

  const worldPlain = buildAction(request("quarantineBuild"));
  check("a build quarantine with no account is accepted", worldPlain.ok && worldPlain.draft.subjectId === "");

  const longSubject = buildAction(request("flagAccount", { subjectId: "a".repeat(ACTION_LIMITS.ID_MAX_CHARS + 1) }));
  check("an over-long account id is refused", !longSubject.ok && longSubject.refusal === REFUSE.FIELD_TOO_LONG, refusalOf(longSubject));

  const longActor = buildAction(request("flagAccount", { actorId: "a".repeat(ACTION_LIMITS.ID_MAX_CHARS + 1) }));
  check("an over-long operator id is refused", !longActor.ok && longActor.refusal === REFUSE.FIELD_TOO_LONG, refusalOf(longActor));

  const spaced = buildAction(request("flagAccount", { actorId: " brett ", subjectId: " acct-1 " }));
  check(
    "names are stored trimmed, so the same person is not two people",
    spaced.ok && spaced.draft.actorId === "brett" && spaced.draft.subjectId === "acct-1",
  );
}

/* ---- fields ----------------------------------------------------------------------------------- */

section("the fields an action needs");
{
  const missing = buildAction(request("grantGold", { fields: {} }));
  check("a grant with no amount is refused", !missing.ok && missing.refusal === REFUSE.FIELD_MISSING, refusalOf(missing));

  const extra = buildAction(request("grantGold", { fields: { amount: 10, marks: 10 } }));
  check(
    "a field the action does not have is refused, not dropped",
    !extra.ok && extra.refusal === REFUSE.FIELD_UNEXPECTED && extra.field === "marks",
    refusalOf(extra),
  );

  const text = buildAction(request("grantGold", { fields: { amount: "250" } }));
  check("an amount typed as text is refused", !text.ok && text.refusal === REFUSE.FIELD_NOT_A_NUMBER, refusalOf(text));

  for (const bad of [0, -5, 1.5, ACTION_LIMITS.AMOUNT_MAX + 1]) {
    const result = buildAction(request("grantGold", { fields: { amount: bad } }));
    check(`an amount of ${bad} is refused`, !result.ok && result.refusal === REFUSE.FIELD_OUT_OF_RANGE, refusalOf(result));
  }

  const atCap = buildAction(request("grantGold", { fields: { amount: ACTION_LIMITS.AMOUNT_MAX } }));
  check("an amount exactly at the fat-finger fence is accepted", atCap.ok, refusalOf(atCap));

  const emptyId = buildAction(request("revokeRun", { fields: { runId: "  " } }));
  check("a blank run id is refused", !emptyId.ok && emptyId.refusal === REFUSE.FIELD_MISSING, refusalOf(emptyId));

  const numericId = buildAction(request("revokeRun", { fields: { runId: 7 } }));
  check("a run id that is a number is refused", !numericId.ok && numericId.refusal === REFUSE.FIELD_MISSING, refusalOf(numericId));

  const longId = buildAction(request("revokeRun", { fields: { runId: "r".repeat(ACTION_LIMITS.ID_MAX_CHARS + 1) }}));
  check("an over-long run id is refused", !longId.ok && longId.refusal === REFUSE.FIELD_TOO_LONG, refusalOf(longId));

  const twoFields = buildAction(request("removeScore"));
  check(
    "an action with two fields carries both",
    twoFields.ok && twoFields.draft.payload.boardId === "boardId-9" && twoFields.draft.payload.runId === "runId-9",
  );
}

/* ---- the mute ladder -------------------------------------------------------------------------- */

section("mute lengths come from the ladder");
{
  for (const hours of MUTE_HOURS) {
    const result = buildAction(request("chatMute", { fields: { hours } }));
    check(`a ${hours}-hour mute is accepted`, result.ok && result.draft.payload.hours === hours, refusalOf(result));
  }

  for (const hours of [1, 25, 720, 0, -24]) {
    const result = buildAction(request("chatMute", { fields: { hours } }));
    check(
      `a ${hours}-hour mute is refused because it is not on the ladder`,
      !result.ok && result.refusal === REFUSE.FIELD_NOT_ALLOWED_VALUE,
      refusalOf(result),
    );
  }

  check("the ladder is a day then a week", MUTE_HOURS[0] === 24 && MUTE_HOURS[1] === 168);
  check("a permanent mute is not on the ladder", !MUTE_HOURS.includes(0 as never));
}

/* ---- time ------------------------------------------------------------------------------------- */

section("when it happened");
{
  const kept = buildAction(request("flagAccount"));
  check("the time handed in is the time recorded", kept.ok && kept.draft.at === NOW);

  for (const at of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    const result = buildAction(request("flagAccount", { at }));
    check(`a timestamp of ${String(at)} is refused`, !result.ok && result.refusal === REFUSE.BAD_TIME, refusalOf(result));
  }
}

/* ---- unknown buttons -------------------------------------------------------------------------- */

section("a button that does not exist");
{
  for (const id of ["", "banAccount", "reversal", "grantgold", "grantGold "]) {
    const result = buildAction(request(id));
    check(`"${id}" is refused as an unknown action`, !result.ok && result.refusal === REFUSE.UNKNOWN_ACTION, refusalOf(result));
  }

  // A near-miss of a real id must not be quietly corrected to the real one. Autocorrect on an admin
  // action is how a mute becomes a ban.
  const near = buildAction(request("grantGold"));
  check("the correctly spelled action still works", near.ok, refusalOf(near));
}

/* ---- grouping --------------------------------------------------------------------------------- */

section("actions taken about one incident");
{
  const grouped = buildAction(request("flagAccount", { groupId: " incident-88 " }));
  check("a group id is kept and trimmed", grouped.ok && grouped.draft.groupId === "incident-88");

  const lone = buildAction(request("flagAccount"));
  check("a lone action has no group", lone.ok && lone.draft.groupId === "");
}

/* ---- nothing is shared between rows ----------------------------------------------------------- */

section("two rows built from one request do not share anything");
{
  const shape = request("grantGold");
  const first = buildAction(shape);
  const second = buildAction(shape);
  if (first.ok && second.ok) {
    check("the two payloads are different objects", first.draft.payload !== second.draft.payload);
    check("the request's own fields were not written into", Object.keys(shape.fields).length === 1);
  } else {
    check("both rows built", false, `${refusalOf(first)} / ${refusalOf(second)}`);
  }
}

/* ---- done ------------------------------------------------------------------------------------- */

console.log(`\n${checks - failures}/${checks} checks passed`);
console.log(`${failures === 0 ? "PASS" : "FAIL"} — break-glass action catalogue`);

if (failures > 0) {
  const host = globalThis as unknown as { process?: { exit?: (code: number) => void } };
  host.process?.exit?.(1);
  throw new Error(`action catalogue: ${failures} check${failures === 1 ? "" : "s"} failed`);
}
