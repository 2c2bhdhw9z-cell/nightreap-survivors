import { useState } from "react";
import { useStory } from "../../queries/admin";

/**
 * Everything ever done to one account, newest first.
 *
 * WHY THERE IS NO UN-BAN BUTTON HERE
 * Lifting a punishment is undoing the row that made it, not writing a cheerful opposite row. Done that way,
 * the punishment keeps its author, its reason and its date forever, and the lift gets its own author, reason
 * and date. A row cannot be edited and cannot be deleted, so the only honest way to show a lifted
 * punishment is to show it greyed out with the lift underneath it.
 *
 * Whether a row can be lifted at all is answered by the server. This file does not keep its own list of
 * what is liftable, because a screen that decided that for itself would eventually offer to lift something
 * the record refuses to lift.
 */

export interface TimelineRow {
  seq: number;
  kind: number;
  kindName: string;
  actorId: string;
  at: number;
  payload: Record<string, string | number | boolean>;
  reverses: number;
  restores: number;
  groupId: string;
  undoneBySeq: number;
  undoable: boolean;
}

const NICE_NAMES: Record<string, string> = {
  ACCOUNT_CREATED: "Account created",
  GOLD_GRANTED: "Gold given",
  MARKS_GRANTED: "Reaper marks given",
  UNLOCK_GRANTED: "Unlock given",
  RUN_SUBMITTED: "Run sent in",
  RUN_ACCEPTED: "Run accepted",
  RUN_REJECTED: "Run turned away",
  RUN_REVOKED: "Run thrown out",
  SCORE_REMOVED: "Score taken off the board",
  ACCOUNT_FLAGGED: "Account flagged",
  ACCOUNT_SEGREGATED: "Kept off the ladders",
  ACCOUNT_RESTORED: "Put back in good standing",
  CHAT_STRIKE: "Chat warning",
  CHAT_MUTED: "Muted",
  CHAT_BANNED: "Chat banned",
  CHAT_CLEARED: "Chat record wiped clean",
  BUILD_QUARANTINED: "Build held back",
  BUILD_RELEASED: "Build let through",
  CONFIG_PUBLISHED: "Settings published",
  SEASON_CLOSED: "Season closed",
  ADMIN_NOTE: "Note",
  REVERSAL: "Undone",
};

function when(at: number): string {
  return new Date(at).toLocaleString();
}

// Bookkeeping the line already says out loud somewhere else, or in words the record keeps for itself. An
// operator reading a history does not need to be shown the machinery.
const PLUMBING = new Set(["action", "ofKind", "ofGroup", "undoneBySeq"]);

const FIELD_WORDS: Record<string, string> = {
  reason: "why",
  restoreReason: "why it was put back",
  amount: "amount",
  hours: "hours",
  forever: "permanent",
};

function payloadLine(payload: Record<string, string | number | boolean>): string {
  return Object.entries(payload)
    .filter(([key]) => !PLUMBING.has(key))
    .map(([key, value]) => `${FIELD_WORDS[key] ?? key}: ${String(value)}`)
    .join(" · ");
}

function Story({ seq }: { seq: number }) {
  const story = useStory(seq);
  if (story.isLoading) return <div className="mt-2 text-xs text-zinc-500">Reading the history…</div>;
  if (story.isError) return <div className="mt-2 text-xs text-red-300">Could not read the history.</div>;

  const steps = story.data?.steps ?? [];
  const words: Record<string, string> = { did: "done", undid: "undone", redid: "put back" };

  return (
    <ol className="mt-2 space-y-1 border-l border-zinc-700 pl-3 text-xs text-zinc-400">
      {steps.map((step) => (
        <li key={step.seq}>
          <span className="text-zinc-200">{words[step.role] ?? step.role}</span> by {step.actorId} — {when(step.at)}
        </li>
      ))}
      {steps.length === 0 ? <li>Nothing has happened to this one since.</li> : null}
    </ol>
  );
}

export function Timeline({
  rows,
  busy,
  onUndo,
  onRedo,
}: {
  rows: TimelineRow[];
  busy: boolean;
  onUndo: (seq: number) => void;
  onRedo: (reversalSeq: number) => void;
}) {
  const [open, setOpen] = useState(0);

  if (rows.length === 0) return <p className="text-sm text-zinc-500">Nothing on record for this account.</p>;

  return (
    <ul className="space-y-2">
      {rows.map((row) => {
        const undone = row.undoneBySeq > 0;
        const isUndo = row.reverses > 0;
        return (
          <li
            key={row.seq}
            className={
              undone
                ? "rounded border border-zinc-800 bg-zinc-950/60 p-3 opacity-50"
                : "rounded border border-zinc-800 bg-zinc-900/50 p-3"
            }
          >
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div>
                <span className={undone ? "text-sm font-semibold text-zinc-400 line-through" : "text-sm font-semibold text-zinc-100"}>
                  {NICE_NAMES[row.kindName] ?? row.kindName}
                </span>
                <span className="ml-2 text-xs text-zinc-500">#{row.seq}</span>
                {isUndo ? <span className="ml-2 text-xs text-amber-400">undid #{row.reverses}</span> : null}
                {row.restores > 0 ? <span className="ml-2 text-xs text-amber-400">put back what #{row.restores} undid</span> : null}
                {row.groupId === "" ? null : <span className="ml-2 text-xs text-zinc-600">batch {row.groupId}</span>}
              </div>
              <div className="text-xs text-zinc-500">
                {row.actorId} · {when(row.at)}
              </div>
            </div>

            {payloadLine(row.payload) === "" ? null : <div className="mt-1 text-xs text-zinc-400">{payloadLine(row.payload)}</div>}

            {undone ? <div className="mt-1 text-xs text-amber-400">Lifted by #{row.undoneBySeq}. Still on record, as it must be.</div> : null}

            <div className="mt-2 flex flex-wrap gap-3 text-xs">
              {row.undoable && !undone ? (
                <button type="button" disabled={busy} onClick={() => onUndo(row.seq)} className="text-amber-300 hover:underline disabled:opacity-40">
                  Undo this
                </button>
              ) : null}
              {isUndo ? (
                <button type="button" disabled={busy} onClick={() => onRedo(row.seq)} className="text-amber-300 hover:underline disabled:opacity-40">
                  Put it back
                </button>
              ) : null}
              <button type="button" onClick={() => setOpen(open === row.seq ? 0 : row.seq)} className="text-zinc-400 hover:underline">
                {open === row.seq ? "Hide history" : "History"}
              </button>
            </div>

            {open === row.seq ? <Story seq={row.seq} /> : null}
          </li>
        );
      })}
    </ul>
  );
}
