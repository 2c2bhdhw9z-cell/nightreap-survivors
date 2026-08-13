/**
 * The break-glass action catalogue.
 *
 * This is the list of things a human at the admin page is allowed to do to a live account, and the exact
 * shape each one has to arrive in. It is pure: nothing here reads a database, writes a row, or knows an
 * endpoint exists. It turns "the operator pressed BAN with this reason" into a draft row, or into a
 * refusal, and that is all — which is why it can be tested to death without a server.
 *
 * WHY A CATALOGUE AND NOT A FORM
 * The alternative is the admin page posting a kind number and a payload of its own invention. That works
 * right up until the day someone bans an account with the mute kind, or grants gold with the amount in a
 * field the projection does not read, and the log then contains a row that is intact, provable, and wrong.
 * A closed list of actions means the screen cannot express a row the log does not understand.
 *
 * THERE IS NO UN-BAN BUTTON, AND THAT IS DELIBERATE
 * Every action here goes one way. Lifting a ban, a flag, a mute or a grant is *undoing the row that did
 * it*, through the reversal path that already exists — so the ban keeps its author, its reason and its
 * date, and the lift gets its own. A pair of opposite buttons would let history read as "banned, unbanned"
 * with nobody's name on the second half, and after two rounds of that nobody can tell what the current
 * state is without guessing. `CHAT_CLEARED` is the one bulk mercy row, and it says so.
 *
 * WHAT IS NOT HERE
 * Reversal and restore, because the log owns those and the rules are enforced there rather than at a
 * second, drifting copy in front of them. And config publishing, which is a document about the world
 * rather than an action about a person.
 */

import { ACTOR, EVENT, isKnownKind, REVERSIBLE, type EventDraft, type Scalar } from "./log";

/* ---------------------------------------------------------------------------------------------- */
/* Refusals                                                                                        */
/* ---------------------------------------------------------------------------------------------- */

/**
 * Why a proposed action was not turned into a row.
 *
 * Append-only, exactly like the event kinds: these numbers end up in logs and screenshots, so reusing one
 * for a different meaning makes old evidence lie.
 */
export const REFUSE = {
  NONE: 0,
  UNKNOWN_ACTION: 1,
  NO_ACTOR: 2,
  SUBJECT_REQUIRED: 3,
  SUBJECT_FORBIDDEN: 4,
  REASON_TOO_THIN: 5,
  FIELD_MISSING: 6,
  FIELD_NOT_A_NUMBER: 7,
  FIELD_OUT_OF_RANGE: 8,
  FIELD_TOO_LONG: 9,
  FIELD_UNEXPECTED: 10,
  FIELD_NOT_ALLOWED_VALUE: 11,
  BAD_TIME: 12,
} as const;

export type RefuseReason = (typeof REFUSE)[keyof typeof REFUSE];

export const REFUSE_NAMES: Readonly<Record<number, string>> = Object.freeze(
  Object.fromEntries(Object.entries(REFUSE).map(([name, id]) => [id, name])),
);

/* ---------------------------------------------------------------------------------------------- */
/* Limits                                                                                          */
/* ---------------------------------------------------------------------------------------------- */

export const ACTION_LIMITS = {
  /**
   * A reason has to be a sentence, not a keystroke.
   *
   * Eight characters is low enough that "chargeback" and "vac ban" fit and high enough that "x", ".", and
   * "asdf" do not. The point is not to make operators write essays; it is that six months later the only
   * person who can explain a row is the row.
   */
  REASON_MIN_CHARS: 8,
  REASON_MAX_CHARS: 512,
  /** Free-text identifiers inside a payload: a run id, an unlock id, a snapshot id. */
  ID_MAX_CHARS: 64,
  /**
   * The largest single grant.
   *
   * Not a game-balance number — a fat-finger fence. A grant bigger than this is either a mistake or an
   * incident, and both want a second person involved rather than one keystroke.
   */
  AMOUNT_MAX: 1_000_000,
} as const;

/** The mute ladder, as decided: a day, then a week. Anything longer is a chat ban, which is its own row. */
export const MUTE_HOURS = [24, 168] as const;

/* ---------------------------------------------------------------------------------------------- */
/* Field shapes                                                                                    */
/* ---------------------------------------------------------------------------------------------- */

type FieldSpec =
  | { readonly type: "id" }
  | { readonly type: "amount" }
  | { readonly type: "oneOf"; readonly values: readonly number[] };

/** What one action is and what it needs. `undoable` is asserted against the log's own set, never trusted. */
export interface ActionSpec {
  /** The event kind the row is written as. */
  readonly kind: number;
  /** True when the action is about a person; false when it is about the world. */
  readonly aboutAnAccount: boolean;
  /** Extra fields beyond actor, subject and reason. */
  readonly fields: Readonly<Record<string, FieldSpec>>;
  /** Plain-English label for the screen. */
  readonly label: string;
  /** What the operator is warned this cannot be walked back from, when it cannot. */
  readonly note?: string;
}

/**
 * Every action, keyed by the id the screen sends.
 *
 * Ids are strings rather than numbers because they are only ever a wire name for a button; the thing that
 * gets stored is the event kind. They are still effectively append-only, since they are written into the
 * payload of every row they produce.
 */
export const ACTIONS: Readonly<Record<string, ActionSpec>> = Object.freeze({
  grantGold: {
    kind: EVENT.GOLD_GRANTED,
    aboutAnAccount: true,
    fields: { amount: { type: "amount" } },
    label: "Give gold back",
  },
  grantMarks: {
    kind: EVENT.MARKS_GRANTED,
    aboutAnAccount: true,
    fields: { amount: { type: "amount" } },
    label: "Give Reaper Marks back",
  },
  grantUnlock: {
    kind: EVENT.UNLOCK_GRANTED,
    aboutAnAccount: true,
    fields: { unlockId: { type: "id" } },
    label: "Give an unlock back",
  },
  revokeRun: {
    kind: EVENT.RUN_REVOKED,
    aboutAnAccount: true,
    fields: { runId: { type: "id" } },
    label: "Revoke a run",
  },
  removeScore: {
    kind: EVENT.SCORE_REMOVED,
    aboutAnAccount: true,
    fields: { boardId: { type: "id" }, runId: { type: "id" } },
    label: "Take a score off a board",
  },
  flagAccount: {
    kind: EVENT.ACCOUNT_FLAGGED,
    aboutAnAccount: true,
    fields: {},
    label: "Flag for review",
  },
  segregateAccount: {
    kind: EVENT.ACCOUNT_SEGREGATED,
    aboutAnAccount: true,
    fields: {},
    label: "Move to the shadow pool",
  },
  restoreAccount: {
    kind: EVENT.ACCOUNT_RESTORED,
    aboutAnAccount: true,
    fields: { snapshotId: { type: "id" } },
    label: "Restore from a snapshot",
    note: "A restore cannot be undone. It is a statement that the account was put back, and putting it back again is a fresh restore from a fresh snapshot.",
  },
  chatStrike: {
    kind: EVENT.CHAT_STRIKE,
    aboutAnAccount: true,
    fields: {},
    label: "Add a chat strike",
  },
  chatMute: {
    kind: EVENT.CHAT_MUTED,
    aboutAnAccount: true,
    fields: { hours: { type: "oneOf", values: MUTE_HOURS } },
    label: "Mute chat",
  },
  chatBan: {
    kind: EVENT.CHAT_BANNED,
    aboutAnAccount: true,
    fields: {},
    label: "Ban from chat permanently",
  },
  chatClear: {
    kind: EVENT.CHAT_CLEARED,
    aboutAnAccount: true,
    fields: {},
    label: "Clear everything chat-related",
    note: "Lifts the mute, the ban and the strikes in one row. It cannot be undone, because undoing mercy is not a thing this page will do.",
  },
  quarantineBuild: {
    kind: EVENT.BUILD_QUARANTINED,
    aboutAnAccount: false,
    fields: { build: { type: "amount" } },
    label: "Quarantine a build",
  },
  releaseBuild: {
    kind: EVENT.BUILD_RELEASED,
    aboutAnAccount: false,
    fields: { build: { type: "amount" } },
    label: "Release a build",
    note: "Releasing cannot be undone. To stop a build again, quarantine it again.",
  },
  note: {
    kind: EVENT.ADMIN_NOTE,
    aboutAnAccount: true,
    fields: {},
    label: "Write a note",
    note: "A note is somebody's account of events, so it can never be edited or undone.",
  },
});

/* ---------------------------------------------------------------------------------------------- */
/* The catalogue, described for the screen                                                         */
/* ---------------------------------------------------------------------------------------------- */

export interface ActionDescription {
  id: string;
  label: string;
  // No kind number here on purpose. The screen posts an action id and nothing else; if it could see the
  // event kind it would eventually send one, and then the vocabulary of the log would be decided by
  // whatever version of the screen happened to be open.
  aboutAnAccount: boolean;
  /** Field names and their kinds, so the screen renders inputs rather than hard-coding them. */
  fields: { name: string; type: string; values: readonly number[] }[];
  /** Read from the log's own reversible set. The screen never keeps its own copy of this answer. */
  undoable: boolean;
  note: string;
}

/**
 * What the screen draws itself from.
 *
 * Derived, never written down — the same discipline as the dev menu's counts. Adding an action above makes
 * a button appear with the right inputs and the right "this cannot be undone" warning, and there is no
 * second list to forget.
 */
export function describeActions(): ActionDescription[] {
  return Object.entries(ACTIONS).map(([id, spec]) => ({
    id,
    label: spec.label,
    aboutAnAccount: spec.aboutAnAccount,
    fields: Object.entries(spec.fields).map(([name, field]) => ({
      name,
      type: field.type,
      values: field.type === "oneOf" ? field.values : [],
    })),
    undoable: REVERSIBLE.has(spec.kind),
    note: spec.note ?? "",
  }));
}

/* ---------------------------------------------------------------------------------------------- */
/* Building a row                                                                                  */
/* ---------------------------------------------------------------------------------------------- */

export interface ActionRequest {
  actionId: string;
  actorId: string;
  subjectId: string;
  reason: string;
  /** Wall-clock milliseconds, decided by the server. */
  at: number;
  /** The action's own fields. Anything not in the spec is a refusal, never a silent drop. */
  fields: Readonly<Record<string, Scalar>>;
  /** Ties several actions taken about one incident together so they can be undone as one. */
  groupId: string;
}

export type ActionResult =
  | { ok: true; draft: EventDraft; refusal: typeof REFUSE.NONE }
  | { ok: false; draft: null; refusal: RefuseReason; field: string };

function refuse(refusal: RefuseReason, field = ""): ActionResult {
  return { ok: false, draft: null, refusal, field };
}

/** A reason is thin if it is short, or if it is one character held down. */
function reasonIsThin(reason: string): boolean {
  const trimmed = reason.trim();
  if (trimmed.length < ACTION_LIMITS.REASON_MIN_CHARS) return true;
  return new Set(trimmed.replace(/\s/g, "")).size < 2;
}

/**
 * Turn a request into a draft row, or say why not.
 *
 * Order matters here for the same reason it does in the log's own validation: the checks that need no
 * context come first, so a refusal is cheap and the expensive path is only reached by a request that is
 * already shaped correctly.
 *
 * The payload always carries the action id and the reason. That is what makes a row readable on its own —
 * the kind says gold was granted, the action id says which button produced it, and the reason says why,
 * without a support person having to join three tables to find out.
 */
export function buildAction(request: ActionRequest): ActionResult {
  const spec = ACTIONS[request.actionId];
  if (spec === undefined) return refuse(REFUSE.UNKNOWN_ACTION, request.actionId);

  if (request.actorId.trim() === "") return refuse(REFUSE.NO_ACTOR, "actorId");
  if (request.actorId.length > ACTION_LIMITS.ID_MAX_CHARS) return refuse(REFUSE.FIELD_TOO_LONG, "actorId");

  const subject = request.subjectId.trim();
  if (spec.aboutAnAccount && subject === "") return refuse(REFUSE.SUBJECT_REQUIRED, "subjectId");
  // An action about the world arriving with an account attached is not a harmless extra. A quarantine that
  // names one player reads, forever, as that player having been punished for it.
  if (!spec.aboutAnAccount && subject !== "") return refuse(REFUSE.SUBJECT_FORBIDDEN, "subjectId");
  if (subject.length > ACTION_LIMITS.ID_MAX_CHARS) return refuse(REFUSE.FIELD_TOO_LONG, "subjectId");

  if (reasonIsThin(request.reason)) return refuse(REFUSE.REASON_TOO_THIN, "reason");
  if (request.reason.length > ACTION_LIMITS.REASON_MAX_CHARS) return refuse(REFUSE.FIELD_TOO_LONG, "reason");

  if (!Number.isSafeInteger(request.at) || request.at <= 0) return refuse(REFUSE.BAD_TIME, "at");

  for (const name of Object.keys(request.fields)) {
    if (!Object.prototype.hasOwnProperty.call(spec.fields, name)) return refuse(REFUSE.FIELD_UNEXPECTED, name);
  }

  const payload: Record<string, Scalar> = { action: request.actionId, reason: request.reason.trim() };

  for (const [name, field] of Object.entries(spec.fields)) {
    const value = request.fields[name];
    if (value === undefined) return refuse(REFUSE.FIELD_MISSING, name);

    if (field.type === "id") {
      if (typeof value !== "string" || value.trim() === "") return refuse(REFUSE.FIELD_MISSING, name);
      if (value.length > ACTION_LIMITS.ID_MAX_CHARS) return refuse(REFUSE.FIELD_TOO_LONG, name);
      payload[name] = value.trim();
      continue;
    }

    if (typeof value !== "number" || !Number.isFinite(value)) return refuse(REFUSE.FIELD_NOT_A_NUMBER, name);

    if (field.type === "oneOf") {
      if (!field.values.includes(value)) return refuse(REFUSE.FIELD_NOT_ALLOWED_VALUE, name);
      payload[name] = value;
      continue;
    }

    if (!Number.isSafeInteger(value) || value <= 0 || value > ACTION_LIMITS.AMOUNT_MAX) {
      return refuse(REFUSE.FIELD_OUT_OF_RANGE, name);
    }
    payload[name] = value;
  }

  return {
    ok: true,
    refusal: REFUSE.NONE,
    draft: {
      kind: spec.kind,
      // A request that arrived through the admin door is an admin action whatever it says it is.
      actorKind: ACTOR.ADMIN,
      actorId: request.actorId.trim(),
      subjectId: subject,
      buildId: 0,
      at: request.at,
      payload,
      reverses: 0,
      restores: 0,
      groupId: request.groupId.trim(),
    },
  };
}

/* ---------------------------------------------------------------------------------------------- */
/* Self-consistency                                                                                */
/* ---------------------------------------------------------------------------------------------- */

/**
 * Prove the catalogue agrees with the log.
 *
 * Called by the tests and by the admin route on first use, so a catalogue that has drifted from the log's
 * vocabulary is a startup failure rather than a bad row discovered during an incident. The three ways this
 * can rot: an action pointing at a kind the log has never heard of, two actions writing the same kind (so
 * the log cannot tell which button was pressed), and a reversal or a run submission being offered as a
 * button when the log will refuse it.
 */
export function catalogueFaults(): string[] {
  const faults: string[] = [];
  const seenKinds = new Map<number, string>();

  for (const [id, spec] of Object.entries(ACTIONS)) {
    if (!isKnownKind(spec.kind)) faults.push(`${id} writes kind ${spec.kind}, which the log does not know`);
    if (spec.kind === EVENT.REVERSAL) faults.push(`${id} would write a reversal, which only the log may do`);
    if (spec.kind === EVENT.RUN_SUBMITTED) faults.push(`${id} would claim a run arrived, which is not an admin action`);

    const already = seenKinds.get(spec.kind);
    if (already !== undefined) faults.push(`${id} and ${already} both write kind ${spec.kind}`);
    seenKinds.set(spec.kind, id);

    if (spec.note === undefined && !REVERSIBLE.has(spec.kind)) {
      faults.push(`${id} cannot be undone but does not say so`);
    }
    if (spec.note !== undefined && REVERSIBLE.has(spec.kind)) {
      faults.push(`${id} carries a warning but is undoable, so the warning is a lie`);
    }
  }

  return faults;
}
