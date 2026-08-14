import { useState } from "react";
import { Button } from "../components/ui/button";
import { ActionForm, reasonProblem, type ActionOption } from "../components/admin/action-form";
import { StandingPanel, type Standing } from "../components/admin/standing";
import { Timeline, type TimelineRow } from "../components/admin/timeline";
import { RunFilters, RunList, RunTally, type RunLog, type RunRow } from "../components/admin/runs";
import {
  useAccount,
  useAccountRuns,
  useActionCatalogue,
  useRecentRuns,
  useRedoRow,
  useRunBlob,
  useTakeAction,
  useUndoRow,
} from "../queries/admin";
import { getAdminToken, setAdminToken } from "../lib/api";

/**
 * Break glass in case of emergency.
 *
 * One player, everything ever done to them, and a fixed list of things that can be done about it. Nothing
 * on this page edits or deletes anything: every button writes a new line in a record that only ever grows,
 * and every line says who did it, when, and why.
 *
 * WHAT IS NOT HERE, AND WHY
 * There is no un-ban button, no un-flag button, no un-mute button. Lifting a punishment is undoing the line
 * that made it, which keeps the punishment's author, reason and date intact and gives the lift its own. A
 * cheerful opposite row would let a ban quietly vanish from the story.
 *
 * There are no kill switches for game features either. Those belong to a settings document rather than to
 * anything about a person, and settings are still handed out from the server's own environment — a button
 * that wrote "feature turned off" while the feature stayed on would be a record that lies.
 */

function TokenGate({ onDone }: { onDone: () => void }) {
  const [typed, setTyped] = useState("");
  return (
    <div className="mx-auto max-w-md space-y-4 p-8">
      <h1 className="text-xl font-semibold text-zinc-100">Break glass</h1>
      <p className="text-sm text-zinc-400">
        This page needs the operator secret. It is kept in this browser tab only, and forgotten the moment the tab closes.
      </p>
      <input
        aria-label="Operator secret"
        type="password"
        value={typed}
        autoComplete="off"
        placeholder="Operator secret"
        onChange={(event) => setTyped(event.target.value)}
        className="w-full rounded border border-zinc-700 bg-zinc-950 px-3 py-2 text-zinc-100"
      />
      <Button
        disabled={typed.length < 16}
        onClick={() => {
          setAdminToken(typed);
          onDone();
        }}
      >
        Unlock
      </Button>
      {typed.length > 0 && typed.length < 16 ? <p className="text-xs text-red-300">That is too short to be the real secret.</p> : null}
    </div>
  );
}

function messageOf(error: unknown): string {
  const shaped = error as { message?: string } | null;
  return shaped?.message ?? "Something went wrong.";
}

function AdminPage() {
  const [unlocked, setUnlocked] = useState(getAdminToken() !== "");
  const [typedId, setTypedId] = useState("");
  const [subjectId, setSubjectId] = useState("");
  const [actorId, setActorId] = useState("");
  const [reason, setReason] = useState("");
  const [said, setSaid] = useState("");
  const [onlyRefused, setOnlyRefused] = useState(false);
  const [onlyFlagged, setOnlyFlagged] = useState(false);
  const [logForId, setLogForId] = useState(0);

  const catalogue = useActionCatalogue(unlocked);
  const account = useAccount(subjectId, unlocked);
  const runs = useRecentRuns({ limit: 25, onlyFlagged, onlyRefused }, unlocked);
  const accountRuns = useAccountRuns(subjectId, unlocked);
  const runLog = useRunBlob(logForId);
  const act = useTakeAction();
  const undo = useUndoRow();
  const redo = useRedoRow();

  if (!unlocked) return <TokenGate onDone={() => setUnlocked(true)} />;

  const busy = act.isPending || undo.isPending || redo.isPending;
  const actions = (catalogue.data?.actions ?? []) as ActionOption[];
  const faults = catalogue.data?.faults ?? [];
  const failure = act.error ?? undo.error ?? redo.error ?? null;

  function lock(): void {
    setAdminToken("");
    setUnlocked(false);
  }

  /** Every write clears the reason box afterwards, so the next one cannot inherit the last one's excuse. */
  function afterWrite(what: string): void {
    setSaid(what);
    setReason("");
  }

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-200">
      <div className="mx-auto max-w-5xl space-y-6 p-6">
        <header className="flex flex-wrap items-baseline justify-between gap-3 border-b border-zinc-800 pb-3">
          <div>
            <h1 className="text-xl font-semibold text-zinc-100">Break glass</h1>
            <p className="text-xs text-zinc-500">Every button writes a line nobody can edit or delete afterwards.</p>
          </div>
          <button type="button" onClick={lock} className="text-xs text-zinc-400 hover:underline">
            Lock this page
          </button>
        </header>

        {catalogue.isError ? (
          <p className="rounded border border-red-900 bg-red-950/60 px-3 py-2 text-sm text-red-200">
            The server would not accept that secret. {messageOf(catalogue.error)}
          </p>
        ) : null}

        {faults.length > 0 ? (
          <div className="rounded border border-red-900 bg-red-950/60 px-3 py-2 text-sm text-red-200">
            <div className="font-semibold">The server says its button list disagrees with the record:</div>
            <ul className="mt-1 list-disc pl-5 text-xs">
              {faults.map((fault) => (
                <li key={fault}>{fault}</li>
              ))}
            </ul>
          </div>
        ) : null}

        <section className="grid gap-3 sm:grid-cols-3">
          <label className="block text-sm sm:col-span-2">
            <span className="text-zinc-400">Player id</span>
            <div className="mt-1 flex gap-2">
              <input
                aria-label="Player id"
                value={typedId}
                onChange={(event) => setTypedId(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") setSubjectId(typedId.trim());
                }}
                placeholder="who this is about"
                className="w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-zinc-100"
              />
              <Button variant="outline" onClick={() => setSubjectId(typedId.trim())}>
                Look up
              </Button>
              {subjectId === "" ? null : (
                <Button
                  variant="ghost"
                  onClick={() => {
                    setTypedId("");
                    setSubjectId("");
                  }}
                >
                  Clear
                </Button>
              )}
            </div>
          </label>
          <label className="block text-sm">
            <span className="text-zinc-400">You are</span>
            <input
              aria-label="Your own name"
              value={actorId}
              onChange={(event) => setActorId(event.target.value)}
              placeholder="your own name"
              className="mt-1 w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-zinc-100"
            />
          </label>
        </section>

        <label className="block text-sm">
          <span className="text-zinc-400">Why</span>
          <textarea
            aria-label="Why"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            rows={2}
            placeholder="What happened. This goes in the record and can never be edited."
            className="mt-1 w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-zinc-100"
          />
          {reason === "" ? null : <span className="text-xs text-red-300">{reasonProblem(reason)}</span>}
        </label>

        {failure === null ? null : (
          <p className="rounded border border-red-900 bg-red-950/60 px-3 py-2 text-sm text-red-200">{messageOf(failure)}</p>
        )}
        {said === "" ? null : <p className="rounded border border-emerald-900 bg-emerald-950/50 px-3 py-2 text-sm text-emerald-200">{said}</p>}

        <div>
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-zinc-500">What can be done</h2>
          {catalogue.isLoading ? (
            <p className="text-sm text-zinc-500">Asking the server what the buttons are…</p>
          ) : (
            <ActionForm
              actions={actions}
              subjectId={subjectId}
              actorId={actorId}
              reason={reason}
              busy={busy}
              onSubmit={(actionId, fields) => {
                setSaid("");
                act.mutate(
                  { actionId, actorId: actorId.trim(), subjectId, reason, fields, groupId: "" },
                  { onSuccess: (result) => afterWrite(`Filed as line #${result.seq}.`) },
                );
              }}
            />
          )}
        </div>

        {subjectId === "" ? (
          <p className="text-sm text-zinc-500">Look a player up to see their standing and their history.</p>
        ) : account.isLoading ? (
          <p className="text-sm text-zinc-500">Reading {subjectId}…</p>
        ) : account.isError ? (
          <p className="rounded border border-red-900 bg-red-950/60 px-3 py-2 text-sm text-red-200">{messageOf(account.error)}</p>
        ) : (
          <div className="space-y-6">
            <div>
              <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-zinc-500">Where {subjectId} stands</h2>
              <StandingPanel standing={account.data?.view as Standing} total={account.data?.total ?? 0} />
            </div>

            <div>
              <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-zinc-500">Everything on record, newest first</h2>
              <p className="mb-2 text-xs text-zinc-500">
                There is no un-ban button. Lifting a punishment means undoing the line that made it, so the punishment keeps its author,
                reason and date, and the lift gets its own. Undoing needs a reason in the box above.
              </p>
              <Timeline
                rows={(account.data?.rows ?? []) as TimelineRow[]}
                busy={busy}
                onUndo={(seq) => {
                  setSaid("");
                  undo.mutate(
                    { seq, actorId: actorId.trim(), reason, groupId: "" },
                    { onSuccess: (result) => afterWrite(`Undone. That is line #${result.seq}.`) },
                  );
                }}
                onRedo={(reversalSeq) => {
                  setSaid("");
                  redo.mutate(
                    { reversalSeq, actorId: actorId.trim(), reason, groupId: "" },
                    { onSuccess: (result) => afterWrite(`Put back. That is line #${result.seq}.`) },
                  );
                }}
              />
            </div>

            <div>
              <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-zinc-500">
                Runs {subjectId} has sent in
              </h2>
              {accountRuns.isLoading ? (
                <p className="text-sm text-zinc-500">Reading their uploads…</p>
              ) : accountRuns.isError ? (
                <p className="rounded border border-red-900 bg-red-950/60 px-3 py-2 text-sm text-red-200">
                  {messageOf(accountRuns.error)}
                </p>
              ) : (
                <div className="space-y-3">
                  <RunTally
                    accepted={accountRuns.data?.accepted ?? 0}
                    refused={accountRuns.data?.refused ?? 0}
                    flagged={accountRuns.data?.flagged ?? 0}
                  />
                  <RunList
                    rows={(accountRuns.data?.rows ?? []) as RunRow[]}
                    log={(runLog.data ?? null) as RunLog | null}
                    logForId={logForId}
                    logBusy={runLog.isLoading}
                    logProblem={runLog.isError ? messageOf(runLog.error) : ""}
                    onFetchLog={(id) => setLogForId(id)}
                    onLookUp={(id) => {
                      setTypedId(id);
                      setSubjectId(id);
                    }}
                    empty="They have never sent a run in."
                  />
                </div>
              )}
            </div>
          </div>
        )}

        <div>
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-zinc-500">Runs that came in, newest first</h2>
          <p className="mb-2 text-xs text-zinc-500">
            Nothing here can be ticked off. The switches only narrow the list; a run being looked at is not a fact about the run. If a
            run deserves a consequence, file it from the buttons above, where it gets a name, a reason and a date.
          </p>
          <RunFilters
            onlyRefused={onlyRefused}
            onlyFlagged={onlyFlagged}
            showing={runs.data?.rows.length ?? 0}
            onChange={(next) => {
              setOnlyRefused(next.onlyRefused);
              setOnlyFlagged(next.onlyFlagged);
            }}
          />
          <div className="mt-3">
            {runs.isLoading ? (
              <p className="text-sm text-zinc-500">Reading what has arrived…</p>
            ) : runs.isError ? (
              <p className="rounded border border-red-900 bg-red-950/60 px-3 py-2 text-sm text-red-200">{messageOf(runs.error)}</p>
            ) : (
              <RunList
                rows={(runs.data?.rows ?? []) as RunRow[]}
                log={(runLog.data ?? null) as RunLog | null}
                logForId={logForId}
                logBusy={runLog.isLoading}
                logProblem={runLog.isError ? messageOf(runLog.error) : ""}
                onFetchLog={(id) => setLogForId(id)}
                onLookUp={(id) => {
                  setTypedId(id);
                  setSubjectId(id);
                }}
                empty="No runs have been sent in yet."
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default AdminPage;
